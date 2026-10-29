import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from '../domain/errors.js';
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
      request.rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  void app.register(helmet, { global: true });
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
