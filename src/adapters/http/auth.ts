import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiClient } from '../../core/domain/types.js';
import type { ApiClientService } from '../../core/services/api-client-service.js';
import type { NonceRepository } from '../../core/ports/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    authScope?: 'admin' | 'api';
    apiClient?: ApiClient;
    rawBody?: string;
  }
}

export type AuthOptions = {
  adminToken: string;
  apiClients: ApiClientService;
  nonces: NonceRepository;
  /** Janela aceita para X-Timestamp, em segundos. */
  timestampWindowSeconds?: number;
};

const TIMESTAMP_WINDOW = 300;

/**
 * Autenticacao:
 *  - `/v1/*`      -> API key (Bearer) + HMAC de requisicao
 *  - `/admin/api/*` -> Bearer ADMIN_TOKEN
 *  - demais rotas -> publicas (pagina de pagamento/health)
 *
 * Assinatura: HMAC-SHA256(requestSecret, "METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)").
 * Headers: X-Timestamp (unix segundos), X-Nonce, X-Signature (`v1=<hex>`).
 */
export function createAuthHook(options: AuthOptions) {
  const windowSeconds = options.timestampWindowSeconds ?? TIMESTAMP_WINDOW;
  const failures = new Map<string, { n: number; reset: number }>();
  const windowMs = 60_000;
  const maxFailures = 20;

  const blocked = (ip: string): boolean => {
    const now = Date.now();
    const slot = failures.get(ip);
    if (!slot || now >= slot.reset) return false;
    return slot.n >= maxFailures;
  };

  const recordFailure = (ip: string): void => {
    const now = Date.now();
    const slot = failures.get(ip);
    if (!slot || now >= slot.reset) {
      failures.set(ip, { n: 1, reset: now + windowMs });
      return;
    }
    slot.n += 1;
  };

  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split('?')[0] ?? '';

    if (path.startsWith('/v1/')) {
      await authenticateApi(request, reply);
      return;
    }
    if (path.startsWith('/admin/api/')) {
      await authenticateAdmin(request, reply);
      return;
    }
  };

  async function authenticateAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      await reply.code(401).send({ erro: 'token de acesso ausente' });
      return;
    }
    if (!safeCompare(header.slice(7).trim(), options.adminToken)) {
      await reply.code(403).send({ erro: 'token de acesso invalido' });
      return;
    }
    request.authScope = 'admin';
  }

  async function authenticateApi(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (blocked(request.ip)) {
      await reply.code(429).send({ erro: 'muitas tentativas de autenticacao' });
      return;
    }

    const header = request.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      recordFailure(request.ip);
      await reply.code(401).send({ erro: 'api key ausente' });
      return;
    }
    const apiKey = header.slice(7).trim();
    const client = await options.apiClients.authenticate(apiKey);
    if (!client) {
      recordFailure(request.ip);
      await reply.code(401).send({ erro: 'api key invalida ou inativa' });
      return;
    }

    const timestampRaw = headerValue(request, 'x-timestamp');
    const nonce = headerValue(request, 'x-nonce');
    const signatureRaw = headerValue(request, 'x-signature');
    if (!timestampRaw || !nonce || !signatureRaw) {
      recordFailure(request.ip);
      await reply.code(401).send({
        erro: 'X-Timestamp, X-Nonce e X-Signature sao obrigatorios',
      });
      return;
    }

    const timestamp = Number(timestampRaw);
    if (!Number.isInteger(timestamp) || timestamp <= 0) {
      recordFailure(request.ip);
      await reply.code(401).send({ erro: 'X-Timestamp invalido' });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > windowSeconds) {
      recordFailure(request.ip);
      await reply.code(401).send({ erro: 'X-Timestamp fora da janela permitida' });
      return;
    }
    if (nonce.length < 8 || nonce.length > 128) {
      recordFailure(request.ip);
      await reply.code(401).send({ erro: 'X-Nonce invalido' });
      return;
    }

    const body = request.rawBody ?? '';
    const canonical = [
      request.method.toUpperCase(),
      request.url.split('?')[0] ?? '',
      String(timestamp),
      nonce,
      createHash('sha256').update(body, 'utf8').digest('hex'),
    ].join('\n');
    const expected = createHmac('sha256', client.requestSecret)
      .update(canonical, 'utf8')
      .digest('hex');
    const provided = signatureRaw.replace(/^v1=/, '').trim();
    if (!safeCompareHex(provided, expected)) {
      recordFailure(request.ip);
      await reply.code(401).send({ erro: 'assinatura invalida' });
      return;
    }

    const fresh = await options.nonces.use(
      client.id,
      nonce,
      new Date((timestamp + windowSeconds) * 1_000),
    );
    if (!fresh) {
      recordFailure(request.ip);
      await reply.code(409).send({ erro: 'nonce ja utilizado' });
      return;
    }

    request.authScope = 'api';
    request.apiClient = client;
  }
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const COMPARE_KEY = Buffer.from('motor-cripto/auth-compare/v1');

function safeCompare(a: string, b: string): boolean {
  const ha = createHmac('sha256', COMPARE_KEY).update(a, 'utf8').digest();
  const hb = createHmac('sha256', COMPARE_KEY).update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

function safeCompareHex(a: string, b: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
