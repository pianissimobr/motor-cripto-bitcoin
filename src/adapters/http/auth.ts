import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Escopo resolvido pelo hook; ausente em rotas publicas. */
    authScope?: 'admin' | 'readonly';
  }
}

/**
 * Autenticacao por Bearer token (comparacao em tempo constante).
 * O token vem do ambiente; nunca e devolvido em respostas ou logs.
 */
export type AuthOptions = {
  adminToken: string;
  /** Token opcional que so pode ler (GET/HEAD). */
  readonlyToken?: string | undefined;
  /** Rotas publicas (ex.: health). */
  publicPaths?: string[];
};

export function createAuthHook(options: AuthOptions) {
  const publicPaths = new Set(options.publicPaths ?? ['/api/health', '/health']);
  const readonlyToken = options.readonlyToken;
  const failures = new Map<string, { n: number; reset: number }>();
  const windowMs = 60_000;
  const maxFailures = 10;

  const failureCount = (ip: string): number => {
    const now = Date.now();
    const slot = failures.get(ip);
    if (!slot || now >= slot.reset) return 0;
    return slot.n;
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
    // Somente a API exige token: as paginas web sao estaticas e o token
    // e enviado no cabecalho a cada chamada.
    if (!path.startsWith('/api/')) return;
    if (publicPaths.has(path)) return;

    const header = request.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      if (failureCount(request.ip) >= maxFailures) {
        await reply.code(429).send({ erro: 'muitas tentativas de autenticacao' });
        return;
      }
      recordFailure(request.ip);
      await reply.code(401).send({ erro: 'token de acesso ausente' });
      return;
    }
    const provided = header.slice(7).trim();

    if (safeCompare(provided, options.adminToken)) {
      request.authScope = 'admin';
      return;
    }

    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (readonlyToken && isRead && safeCompare(provided, readonlyToken)) {
      request.authScope = 'readonly';
      return;
    }

    if (failureCount(request.ip) >= maxFailures) {
      await reply.code(429).send({ erro: 'muitas tentativas de autenticacao' });
      return;
    }
    recordFailure(request.ip);
    await reply.code(403).send({
      erro: isRead ? 'token de acesso invalido' : 'token sem permissao de escrita',
    });
  };
}

/** HMAC dos dois lados: o tamanho do token nao sai no tempo da comparacao. */
const COMPARE_KEY = Buffer.from('motor-cripto/auth-compare/v1');

function safeCompare(a: string, b: string): boolean {
  const ha = createHmac('sha256', COMPARE_KEY).update(a, 'utf8').digest();
  const hb = createHmac('sha256', COMPARE_KEY).update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
