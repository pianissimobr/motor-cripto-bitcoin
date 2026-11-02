import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { ValidationError, UnauthorizedError, AppError } from '../domain/errors.js';
import type { Logger } from '../logger.js';
import type { AuthService } from '../services/auth-service.js';

export const SESSION_COOKIE = 'portal_sid';
export const CSRF_COOKIE = 'portal_csrf';

export type AuthRoutesDeps = {
  config: AppConfig;
  logger: Logger;
  auth: AuthService;
};

const registerSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    password: z.string().min(8).max(200),
    merchant_name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const emailSchema = z.object({ email: z.string().trim().min(3).max(254) }).strict();
const loginSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(200),
  })
  .strict();
const tokenSchema = z.object({ token: z.string().min(1) }).strict();
const resetSchema = z
  .object({ token: z.string().min(1), password: z.string().min(8).max(200) })
  .strict();
const changePasswordSchema = z
  .object({
    current_password: z.string().min(1).max(200),
    password: z.string().min(8).max(200),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`${what} invalido`, result.error.issues);
  }
  return result.data;
}

function sessionTokenOf(request: FastifyRequest): string {
  const cookies = request.cookies as Record<string, string | undefined>;
  return cookies[SESSION_COOKIE] ?? '';
}

function csrfHeaderOf(request: FastifyRequest): string | undefined {
  const value = request.headers['x-csrf-token'];
  return Array.isArray(value) ? value[0] : value;
}

export { sessionTokenOf, csrfHeaderOf };

function setSessionCookies(
  reply: FastifyReply,
  sessionToken: string,
  csrfToken: string | null,
  config: AppConfig,
): void {
  const secure = config.service.isProduction;
  const maxAge = config.server.sessionTtlSeconds;
  const base = {
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
  reply.setCookie(SESSION_COOKIE, sessionToken, { ...base, httpOnly: true });
  if (csrfToken) {
    reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false });
  }
}

function clearSessionCookies(reply: FastifyReply, config: AppConfig): void {
  const secure = config.service.isProduction;
  const base = {
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  };
  reply.clearCookie(SESSION_COOKIE, { ...base });
  reply.clearCookie(CSRF_COOKIE, { ...base });
}

/** Proteção simples contra credential stuffing por IP+e-mail (em memória). */
function createLoginThrottle(maxFailures = 10, windowMs = 60_000) {
  const buckets = new Map<string, { count: number; reset: number }>();
  return {
    isBlocked(key: string): boolean {
      const now = Date.now();
      const slot = buckets.get(key);
      if (!slot || now >= slot.reset) return false;
      return slot.count >= maxFailures;
    },
    recordFailure(key: string): void {
      const now = Date.now();
      const slot = buckets.get(key);
      if (!slot || now >= slot.reset) {
        buckets.set(key, { count: 1, reset: now + windowMs });
        return;
      }
      slot.count += 1;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): void {
  const throttle = createLoginThrottle();

  app.post('/auth/register', async (request, reply) => {
    const body = parse(registerSchema, request.body ?? {}, 'corpo');
    const result = await deps.auth.register({
      email: body.email,
      password: body.password,
      ...(body.merchant_name ? { merchantName: body.merchant_name } : {}),
    });
    return reply.status(201).send({
      user: result.user,
      merchant: result.merchant,
      verification_token: result.verificationToken,
    });
  });

  app.post('/auth/verify-email', async (request) => {
    const body = parse(tokenSchema, request.body ?? {}, 'corpo');
    return deps.auth.verifyEmail(body.token);
  });

  app.post('/auth/login', async (request, reply) => {
    const body = parse(loginSchema, request.body ?? {}, 'corpo');
    const key = `${request.ip}:${body.email.trim().toLowerCase()}`;
    if (throttle.isBlocked(key)) {
      throw new AppError('muitas tentativas de login', {
        code: 'login_throttled',
        statusCode: 429,
      });
    }
    try {
      const result = await deps.auth.login(body.email, body.password);
      throttle.reset(key);
      setSessionCookies(reply, result.sessionToken, result.csrfToken, deps.config);
      return {
        user: result.user,
        merchants: result.merchants,
      };
    } catch (err) {
      if (err instanceof UnauthorizedError) throttle.recordFailure(key);
      throw err;
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const sessionToken = sessionTokenOf(request);
    if (sessionToken) await deps.auth.logout(sessionToken);
    clearSessionCookies(reply, deps.config);
    return { ok: true };
  });

  app.get('/auth/me', async (request) => {
    const sessionToken = sessionTokenOf(request);
    if (!sessionToken) throw new UnauthorizedError('sessao ausente');
    return deps.auth.me(sessionToken);
  });

  app.post('/auth/forgot-password', async (request) => {
    const body = parse(emailSchema, request.body ?? {}, 'corpo');
    return deps.auth.forgotPassword(body.email);
  });

  app.post('/auth/reset-password', async (request) => {
    const body = parse(resetSchema, request.body ?? {}, 'corpo');
    return deps.auth.resetPassword(body.token, body.password);
  });

  app.post('/auth/change-password', async (request) => {
    const sessionToken = sessionTokenOf(request);
    if (!sessionToken) throw new UnauthorizedError('sessao ausente');
    await deps.auth.assertCsrf(sessionToken, csrfHeaderOf(request));
    const body = parse(changePasswordSchema, request.body ?? {}, 'corpo');
    return deps.auth.changePassword(sessionToken, body.current_password, body.password);
  });
}