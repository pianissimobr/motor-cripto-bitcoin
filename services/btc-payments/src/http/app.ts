import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, ValidationError } from '../domain/errors.js';
import type { Logger } from '../logger.js';
import type { Readiness } from './readiness.js';
import { registerRoutes } from './routes.js';
import { registerApiRoutes, type ApiServices } from './api-routes.js';

export type AppDeps = {
  config: {
    service: {
      name: string;
      version: string;
    };
    server: {
      trustProxy: boolean;
      corsAllowedOrigins: string[];
      rateLimitMax: number;
      rateLimitWindowMs: number;
    };
  };
  logger: Logger;
  readiness: Readiness;
  services?: ApiServices;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: deps.config.server.trustProxy,
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
  });

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      const raw = body as string;
      request.rawBody = raw;
      // POST/DELETE sem corpo (cancelar, pausar, remover carteira) chegam com
      // Content-Type JSON e corpo vazio: isso e "sem corpo", nao erro.
      if (raw.trim().length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(new ValidationError('corpo nao e JSON valido'), undefined);
      }
    },
  );

  void app.register(helmet, { global: true });
  void app.register(cookie);

  const publicDir = join(import.meta.dirname, '..', '..', 'public');
  void app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    wildcard: false,
    index: false,
  });

  // O snippet /checkout.js e carregado por sites de lojistas em outro
  // dominio; o Helmet manda CORP same-origin por padrao, o que o bloqueia.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.split('?')[0] === '/checkout.js') {
      reply.header('cross-origin-resource-policy', 'cross-origin');
    }
    return payload;
  });

  void app.register(cors, {
    origin: deps.config.server.corsAllowedOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-timestamp',
      'x-nonce',
      'x-signature',
      'x-idempotency-key',
    ],
    maxAge: 600,
  });
  void app.register(rateLimit, {
    max: deps.config.server.rateLimitMax,
    timeWindow: deps.config.server.rateLimitWindowMs,
    allowList: (request) => request.url === '/health',
    // A chave e o IP. Usar o cabecalho Authorization (antes de autenticar)
    // deixava qualquer um ganhar um balde novo a cada requisicao trocando o
    // valor do cabecalho. Atras de proxy, ligue TRUST_PROXY.
    keyGenerator: (request) => {
      const path = request.url.split('?')[0] ?? request.url;
      if (path.startsWith('/webhooks/lnbits')) return `lnbits:${request.ip}`;
      return request.ip;
    },
  });

  app.addHook('onRequest', async (request) => {
    deps.logger.debug(
      { method: request.method, path: request.url.split('?')[0] },
      'http request',
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    deps.logger.debug(
      {
        method: request.method,
        path: request.url.split('?')[0],
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'http response',
    );
  });

  registerRoutes(app, {
    service: deps.config.service,
    readiness: deps.readiness,
  });

  if (deps.services) {
    registerApiRoutes(app, deps.services);
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        deps.logger.error(
          { err: error, path: request.url.split('?')[0] },
          'erro de aplicacao',
        );
      }
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.expose ? error.message : 'erro interno',
          ...(error.expose && error.details !== undefined
            ? { details: error.details }
            : {}),
        },
      });
    }

    const fastifyError = error as {
      validation?: unknown;
      message?: string;
      statusCode?: number;
    };
    if (fastifyError.validation) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: fastifyError.message ?? 'requisicao invalida',
        },
      });
    }
    if (
      typeof fastifyError.statusCode === 'number' &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: 'bad_request',
          message: fastifyError.message ?? 'requisicao invalida',
        },
      });
    }

    deps.logger.error(
      { err: error, path: request.url.split('?')[0] },
      'erro nao tratado',
    );
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'erro interno',
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: `rota nao encontrada: ${request.method} ${request.url.split('?')[0]}`,
      },
    });
  });

  return app;
}
