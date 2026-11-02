import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { decryptSecret } from '../crypto/cipher.js';
import {
  buildCanonicalRequest,
  sha256Hex,
  timingSafeEqualHex,
  verifyRequestSignature,
} from '../crypto/hmac.js';
import { ForbiddenError, UnauthorizedError } from '../domain/errors.js';
import type { Repositories } from '../db/repositories.js';
import { DEFAULT_API_SCOPES, type ApiScope } from '../domain/types.js';
import type { Logger } from '../logger.js';

export type ApiSignatureInput = {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
  signature: string;
};

export function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function verifyTimestamp(
  timestamp: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const value = Number(timestamp);
  if (!Number.isSafeInteger(value)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? 300;
  return Math.abs(now - value) <= tolerance;
}

export function verifyApiSignature(input: {
  secret: string;
  request: ApiSignatureInput;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  if (!verifyTimestamp(input.request.timestamp, input)) return false;
  return verifyRequestSignature(
    input.secret,
    {
      method: input.request.method,
      path: input.request.path,
      timestamp: input.request.timestamp,
      nonce: input.request.nonce,
      body: input.request.body,
    },
    input.request.signature,
  );
}

export function canonicalRequestForLog(input: ApiSignatureInput): string {
  return buildCanonicalRequest({
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    body: input.body,
  });
}

export function assertAdminToken(provided: string | undefined, expected: string): void {
  if (!provided) throw new UnauthorizedError('token admin ausente');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedError('token admin invalido');
  }
}

export function assertSignatureMatch(expected: string, provided: string): void {
  if (!timingSafeEqualHex(expected, provided)) {
    throw new UnauthorizedError('assinatura invalida');
  }
}

/**
 * Augmenta o FastifyRequest com o corpo cru (para HMAC) e o cliente autenticado.
 */
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    apiClient?: import('../domain/types.js').ApiClient;
  }
}

export type AuthDeps = {
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
};

function headerString(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createApiAuth(deps: AuthDeps, requiredScope?: ApiScope) {
  return async (
    request: import('fastify').FastifyRequest,
    _reply: import('fastify').FastifyReply,
  ): Promise<void> => {
    const apiKey = parseBearerToken(request.headers.authorization);
    if (!apiKey) throw new UnauthorizedError('api key ausente');

    const client = await deps.repos.findClientByApiKeyHash(sha256Hex(apiKey));
    if (!client || client.status !== 'ativo') {
      throw new UnauthorizedError('api key invalida');
    }

    let requestSecret: string;
    try {
      requestSecret = decryptSecret(
        client.requestSecretEnc,
        deps.config.crypto.keyring,
        client.id,
      );
    } catch (err) {
      deps.logger.error(
        { err, clientId: client.id },
        'falha ao decifrar request secret',
      );
      throw new UnauthorizedError('nao autorizado');
    }

    const timestamp = headerString(request.headers['x-timestamp']);
    const nonce = headerString(request.headers['x-nonce']);
    const signature = headerString(request.headers['x-signature']);
    if (!timestamp || !nonce || !signature) {
      throw new UnauthorizedError(
        'headers x-timestamp, x-nonce e x-signature sao obrigatorios',
      );
    }
    if (nonce.length < 8 || nonce.length > 128) {
      throw new UnauthorizedError('x-nonce deve ter entre 8 e 128 caracteres');
    }

    const valid = verifyApiSignature({
      secret: requestSecret,
      request: {
        method: request.method,
        path: request.url.split('?')[0]!,
        timestamp,
        nonce,
        body: request.rawBody ?? '',
        signature,
      },
    });
    if (!valid) throw new UnauthorizedError('assinatura invalida');

    const accepted = await deps.repos.consumeNonce(
      client.id,
      nonce,
      new Date(Date.now() + 10 * 60 * 1000),
    );
    if (!accepted) throw new UnauthorizedError('nonce reutilizado');

    if (requiredScope) {
      const scopes = client.scopes ?? DEFAULT_API_SCOPES;
      if (!scopes.includes(requiredScope)) {
        throw new ForbiddenError(`escopo ${requiredScope} ausente`);
      }
    }

    request.apiClient = client;
  };
}

export function createAdminAuth(deps: AuthDeps) {
  return async (
    request: import('fastify').FastifyRequest,
    _reply: import('fastify').FastifyReply,
  ): Promise<void> => {
    const token = parseBearerToken(request.headers.authorization);
    assertAdminToken(token ?? undefined, deps.config.server.adminToken);
  };
}
