import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthoIssuerClient } from '../adapters/autho/client.js';
import type { AppConfig } from '../config.js';
import { AppError, UnauthorizedError, ValidationError } from '../domain/errors.js';
import type { DashAuthService } from '../services/dash-auth-service.js';
import {
  clearSessionCookies,
  dashSessionGuard,
  sessionTokenOf,
  setSessionCookies,
} from './dash-session.js';

export type AuthRoutesDeps = {
  config: AppConfig;
  auth: DashAuthService;
  /** Fonte do desafio anti-robo de GET /auth/altcha. */
  autho?: AuthoIssuerClient;
};

const email = z.string().trim().min(3).max(254);
const altcha = z.string().max(4000).optional();
const password = z.string().min(8).max(200);
const codeFields = {
  email,
  request_id: z.string().trim().min(1).max(128),
  code: z.string().regex(/^\d{6}$/, 'codigo de 6 digitos'),
};

const registerSchema = z
  .object({ email, password, merchant_name: z.string().trim().min(1).max(80).optional(), altcha })
  .strict();
const emailSchema = z.object({ email, altcha }).strict();
const loginSchema = z.object({ email, password: z.string().min(1).max(200), altcha }).strict();
const verifySchema = z.union([
  z.object({ token: z.string().min(1).max(200) }).strict(),
  z.object(codeFields).strict(),
]);
const resetSchema = z.union([
  z.object({ token: z.string().min(1).max(200), password }).strict(),
  z.object({ ...codeFields, password }).strict(),
]);
const changePasswordSchema = z
  .object({ current_password: z.string().min(1).max(200), password })
  .strict();
const sessionIdSchema = z.object({ id: z.string().uuid() }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(`${what} invalido`, result.error.issues);
  return result.data;
}

/**
 * Trava por e-mail contra tentativa de senha em massa: o limite por IP nao
 * pega quem troca de IP. Em memoria (uma instancia de API).
 */
export function createLoginThrottle(maxFailures = 10, windowMs = 15 * 60_000, now = () => Date.now()) {
  const buckets = new Map<string, { count: number; reset: number }>();
  return {
    isBlocked(key: string): boolean {
      const slot = buckets.get(key);
      if (!slot || now() >= slot.reset) return false;
      return slot.count >= maxFailures;
    },
    recordFailure(key: string): void {
      const t = now();
      const slot = buckets.get(key);
      if (!slot || t >= slot.reset) {
        if (buckets.size >= 50_000) {
          for (const [k, v] of buckets) if (t >= v.reset) buckets.delete(k);
        }
        buckets.set(key, { count: 1, reset: t + windowMs });
        return;
      }
      slot.count += 1;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}

/** Limite por IP das rotas sensiveis (alem do limite global). */
const STRICT = { rateLimit: { max: 10, timeWindow: 60_000 } };

/**
 * Login e conta do painel do lojista. So entra no app com
 * `DASHBOARD_ENABLED=true`.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const { auth, config } = deps;
  const throttle = createLoginThrottle();
  const guard = dashSessionGuard(auth, config);

  app.get('/auth/config', async () => ({
    signup_enabled: config.dashboard.signupEnabled,
    altcha: deps.autho !== undefined,
    email_code: auth.usesAutho,
  }));

  // Desafio anti-robo (ALTCHA) para o navegador resolver antes de cadastrar,
  // entrar ou pedir troca de senha. 404 sem o authO.
  app.get('/auth/altcha', { config: STRICT }, async (_request, reply) => {
    const challenge = deps.autho ? await deps.autho.challenge() : null;
    if (!challenge) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'anti-robo desligado' } });
    }
    return reply.header('cache-control', 'no-store').send(challenge);
  });

  app.post('/auth/register', { config: STRICT }, async (request, reply) => {
    const body = parse(registerSchema, request.body ?? {}, 'corpo');
    const result = await auth.register({
      email: body.email,
      password: body.password,
      ...(body.merchant_name ? { merchantName: body.merchant_name } : {}),
      ...(body.altcha ? { altcha: body.altcha } : {}),
    });
    return reply.status(202).send({
      request_id: result.requestId,
      ...(result.verificationToken ? { verification_token: result.verificationToken } : {}),
    });
  });

  app.post('/auth/resend-verification', { config: STRICT }, async (request) => {
    const body = parse(emailSchema, request.body ?? {}, 'corpo');
    const result = await auth.resendVerification(body.email, body.altcha);
    return {
      request_id: result.requestId,
      ...(result.verificationToken ? { verification_token: result.verificationToken } : {}),
    };
  });

  app.post('/auth/verify-email', { config: STRICT }, async (request) => {
    const body = parse(verifySchema, request.body ?? {}, 'corpo');
    if ('token' in body) return auth.verifyEmail({ token: body.token });
    return auth.verifyEmail({ email: body.email, requestId: body.request_id, code: body.code });
  });

  app.post('/auth/login', { config: STRICT }, async (request, reply) => {
    const body = parse(loginSchema, request.body ?? {}, 'corpo');
    const key = body.email.trim().toLowerCase();
    if (throttle.isBlocked(key)) {
      throw new AppError('muitas tentativas; aguarde 15 minutos ou redefina a senha', {
        code: 'login_throttled',
        statusCode: 429,
      });
    }
    await auth.assertHuman(body.altcha);
    try {
      const result = await auth.login(body.email, body.password, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      throttle.reset(key);
      setSessionCookies(reply, config, result.sessionToken, result.csrfToken);
      return reply.header('cache-control', 'no-store').send({ user: result.user, merchants: result.merchants });
    } catch (err) {
      if (err instanceof UnauthorizedError) throttle.recordFailure(key);
      throw err;
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = sessionTokenOf(request, config);
    if (token) await auth.logout(token);
    clearSessionCookies(reply, config);
    return { ok: true };
  });

  app.get('/auth/me', async (request, reply) => {
    const token = sessionTokenOf(request, config);
    if (!token) throw new UnauthorizedError('sessao ausente');
    const me = await auth.me(token);
    return reply.header('cache-control', 'no-store').send(me);
  });

  app.post('/auth/forgot-password', { config: STRICT }, async (request) => {
    const body = parse(emailSchema, request.body ?? {}, 'corpo');
    const result = await auth.forgotPassword(body.email, body.altcha);
    return {
      request_id: result.requestId,
      ...(result.resetToken ? { reset_token: result.resetToken } : {}),
    };
  });

  app.post('/auth/reset-password', { config: STRICT }, async (request, reply) => {
    const body = parse(resetSchema, request.body ?? {}, 'corpo');
    const result =
      'token' in body
        ? await auth.resetPassword({ token: body.token, password: body.password })
        : await auth.resetPassword({
            email: body.email,
            requestId: body.request_id,
            code: body.code,
            password: body.password,
          });
    clearSessionCookies(reply, config);
    return result;
  });

  app.post('/auth/change-password', { preHandler: guard, config: STRICT }, async (request) => {
    const body = parse(changePasswordSchema, request.body ?? {}, 'corpo');
    return auth.changePassword(request.dashUser!, request.dashSession!, body.current_password, body.password);
  });

  app.get('/auth/sessions', { preHandler: guard }, async (request) => ({
    sessions: await auth.listSessions(request.dashUser!, request.dashSession!),
  }));

  app.delete('/auth/sessions/:id', { preHandler: guard }, async (request) => {
    const { id } = parse(sessionIdSchema, request.params, 'sessao');
    await auth.revokeSession(request.dashUser!, id);
    return { ok: true };
  });

  app.post('/auth/sessions/revoke-others', { preHandler: guard }, async (request) => ({
    revoked: await auth.revokeOtherSessions(request.dashUser!, request.dashSession!),
  }));
}
