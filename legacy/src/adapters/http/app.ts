import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { GasSponsorBalance } from '../../core/alerts.js';
import { DomainError } from '../../core/domain/errors.js';
import { IllegalTransitionError } from '../../core/domain/link-state.js';
import type { AppConfig } from '../../core/config.js';
import type { Motor } from '../../core/index.js';
import type { Logger } from '../../core/logger.js';
import { createAuthHook } from './auth.js';
import { registerRoutes } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = join(__dirname, '..', '..', '..', 'web');

export type BuildHttpAppOptions = {
  motor: Motor;
  logger: Logger;
  config: AppConfig;
  serveStatic?: boolean;
  webRoot?: string;
};

export async function buildHttpApp(options: BuildHttpAppOptions): Promise<FastifyInstance> {
  const { motor, logger, config } = options;

  const app = Fastify({
    logger: false,
    trustProxy: config.server.trustProxy,
    bodyLimit: 64 * 1024,
  });

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      request.rawBody = raw;
      if (raw.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ erro: 'rate limit excedido' }),
  });

  app.addHook(
    'preValidation',
    createAuthHook({
      adminToken: config.server.adminToken,
      apiClients: motor.apiClients,
      nonces: motor.repos.nonces,
    }),
  );

  if (options.serveStatic !== false) {
    await app.register(fastifyStatic, {
      root: options.webRoot ?? defaultWebRoot,
      prefix: '/',
      index: ['index.html'],
      decorateReply: false,
    });
  }

  const gasSponsorConfigured = Boolean(config.gasSponsor.address || config.gasSponsor.privateKey);
  const loadGasSponsorBalances = async (): Promise<GasSponsorBalance[]> => {
    const profiles = await motor.repos.rampProfiles.list();
    const chains = [...new Set(profiles.map((profile) => profile.chain.toLowerCase()))];
    return Promise.all(
      chains.map(async (chain) => {
        try {
          const balanceWei = await motor.gasSponsor.balance(motor.providerFactory(chain));
          return { chain, balanceWei };
        } catch (err) {
          logger.warn({ err, chain }, 'falha ao consultar saldo do gas sponsor');
          return { chain, balanceWei: null };
        }
      }),
    );
  };

  await registerRoutes(app, {
    motor,
    logger,
    gasSponsor: {
      minBalanceWei: config.gasSponsor.minBalanceWei,
      configured: gasSponsorConfigured,
      balances: gasSponsorConfigured ? loadGasSponsorBalances : undefined,
    },
  });

  app.get('/', async (_request, reply) => reply.redirect('/admin/'));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        erro: 'dados invalidos',
        detalhes: error.issues.map((issue) => ({
          campo: issue.path.join('.'),
          mensagem: issue.message,
        })),
      });
    }
    if (error instanceof IllegalTransitionError) {
      return reply.code(409).send({ erro: error.message, codigo: error.codigo });
    }
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({ erro: error.message, codigo: error.codigo });
    }

    const validation = (error as { validation?: unknown }).validation;
    if (validation) {
      return reply.code(400).send({ erro: 'requisicao invalida' });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const mensagem = error instanceof Error ? error.message : 'requisicao invalida';
      return reply.code(status).send({ erro: mensagem });
    }

    const rota = request.routeOptions?.url ?? request.url.split('?')[0] ?? '';
    logger.error({ err: error, metodo: request.method, rota }, 'erro nao tratado na API');
    return reply.code(500).send({ erro: 'erro interno do servidor' });
  });

  return app;
}
