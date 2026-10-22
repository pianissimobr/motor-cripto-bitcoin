import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Autenticacao por Bearer token (comparacao em tempo constante).
 * O token vem do ambiente; nunca e devolvido em respostas ou logs.
 */
export type AuthOptions = {
  adminToken: string;
  /** Rotas publicas (ex.: health). */
  publicPaths?: string[];
};

export function createAuthHook(options: AuthOptions) {
  const publicPaths = new Set(options.publicPaths ?? ['/api/health', '/health']);

  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split('?')[0] ?? '';
    // Somente a API exige token: as paginas web sao estaticas e o token
    // e enviado no cabecalho a cada chamada.
    if (!path.startsWith('/api/')) return;
    if (publicPaths.has(path)) return;

    const header = request.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      await reply.code(401).send({ erro: 'token de acesso ausente' });
      return;
    }
    const provided = header.slice(7).trim();
    if (!safeCompare(provided, options.adminToken)) {
      await reply.code(403).send({ erro: 'token de acesso invalido' });
      return;
    }
  };
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
