import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { bootstrap } from './bootstrap.js';
import { createAuthHook } from './adapters/http/auth.js';
import { registerRoutes } from './adapters/http/routes.js';

/**
 * Servidor HTTP do motor.
 *
 * - autentica por Bearer token (exceto health)
 * - rate limit por IP
 * - serve as duas paginas web estaticas
 * - helmet para cabecalhos de seguranca
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, '..', 'web');

async function main(): Promise<void> {
  const { config, logger, motor, close } = await bootstrap();

  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

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

  app.addHook('onRequest', createAuthHook({ adminToken: config.server.adminToken }));

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
    index: ['index.html'],
    // arquivos estaticos nao exigem token (o HTML so chama a API com token)
    decorateReply: false,
  });

  await registerRoutes(app, {
    motor,
    logger,
    gasSponsor: {
      minBalanceWei: config.gasSponsor.minBalanceWei,
      enabled: Boolean(config.gasSponsor.privateKey),
    },
  });

  app.get('/', async (_request, reply) => {
    return reply.redirect('/cadastro.html');
  });

  await app.listen({ port: config.server.port, host: config.server.host });
  logger.info(
    { port: config.server.port, host: config.server.host, pid: process.pid },
    'servidor no ar',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando');
    try {
      await app.close();
      await close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'erro ao encerrar');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('falha ao iniciar o servidor:', err);
  process.exit(1);
});
