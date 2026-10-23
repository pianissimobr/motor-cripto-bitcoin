import { bootstrap } from './bootstrap.js';
import { buildHttpApp } from './adapters/http/app.js';

/**
 * Servidor HTTP do motor.
 *
 * A montagem da aplicacao vive em `adapters/http/app.ts` (testavel); aqui
 * ficam o boot, o `listen` e o encerramento gracioso.
 */

async function main(): Promise<void> {
  const { config, logger, motor, close } = await bootstrap(process.env, 'api');

  const app = await buildHttpApp({ motor, logger, config });

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
