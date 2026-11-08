import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Session, User } from '../domain/types.js';
import { UnauthorizedError } from '../domain/errors.js';
import type { DashAuthService } from '../services/dash-auth-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    dashUser?: User;
    dashSession?: Session;
  }
}

/**
 * Cookies do painel. Em producao o da sessao usa o prefixo `__Host-`: o
 * navegador so aceita com Secure, Path=/ e sem Domain, entao um subdominio
 * nao consegue plantar nem ler a sessao.
 */
export function sessionCookieName(config: AppConfig): string {
  return config.service.isProduction ? '__Host-painel_sid' : 'painel_sid';
}
export const CSRF_COOKIE = 'painel_csrf';

export function sessionTokenOf(request: FastifyRequest, config: AppConfig): string {
  const cookies = request.cookies as Record<string, string | undefined>;
  return cookies[sessionCookieName(config)] ?? '';
}

export function csrfHeaderOf(request: FastifyRequest): string | undefined {
  const value = request.headers['x-csrf-token'];
  return Array.isArray(value) ? value[0] : value;
}

function cookieBase(config: AppConfig) {
  return { secure: config.service.isProduction, sameSite: 'lax' as const, path: '/' };
}

export function setSessionCookies(
  reply: FastifyReply,
  config: AppConfig,
  sessionToken: string,
  csrfToken: string,
): void {
  const maxAge = config.server.sessionTtlSeconds;
  reply.setCookie(sessionCookieName(config), sessionToken, { ...cookieBase(config), maxAge, httpOnly: true });
  // O CSRF e lido pelo JS do painel e devolvido no header x-csrf-token.
  reply.setCookie(CSRF_COOKIE, csrfToken, { ...cookieBase(config), maxAge, httpOnly: false });
}

export function clearSessionCookies(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(sessionCookieName(config), cookieBase(config));
  reply.clearCookie(CSRF_COOKIE, cookieBase(config));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * preHandler das rotas do painel: exige sessao valida e, fora de GET, o
 * header CSRF. Preenche `request.dashUser` e `request.dashSession`.
 */
export function dashSessionGuard(auth: DashAuthService, config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = sessionTokenOf(request, config);
    if (!token) throw new UnauthorizedError('sessao ausente');
    const result = SAFE_METHODS.has(request.method)
      ? await auth.authenticate(token)
      : await auth.authenticateWrite(token, csrfHeaderOf(request));
    request.dashUser = result.user;
    request.dashSession = result.session;
    reply.header('cache-control', 'no-store');
  };
}
