import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
import { createLogger } from '../src/logger.js';
import { loadEnv } from '../src/load-env.js';
import { ClientService } from '../src/services/client-service.js';

loadEnv();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.server.logLevel,
    pretty: !config.service.isProduction,
  });
  const db = createDb(config.database);
  const repos = createRepositories(db.db);
  const service = new ClientService({ repos, config, logger });

  try {
    const created = await service.create({
      name: arg('--name') ?? 'Cliente dev',
      webhookUrl:
        arg('--webhook-url') ?? 'http://localhost:9999/webhook',
    });
    console.log(JSON.stringify(created, null, 2));
    console.log(
      '\nGuarde requestSecret e webhookSecret: eles nao sao exibidos de novo.',
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[btc-payments] falha ao criar cliente:', err);
  process.exit(1);
});
