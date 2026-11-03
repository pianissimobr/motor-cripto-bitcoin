import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
import { createLogger } from '../src/logger.js';
import { loadEnv } from '../src/load-env.js';
import { ClientService } from '../src/services/client-service.js';
import { MerchantWalletService } from '../src/services/merchant-wallet-service.js';

/**
 * Cria uma loja com carteira de liquidacao USDC, pronta para o teste de PIX.
 *
 *   npm run merchant:pix:seed -- --address 0x... --name "Loja teste"
 *
 * Imprime as credenciais em JSON: elas nao sao exibidas de novo depois.
 */

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
  const clients = new ClientService({ repos, config, logger });
  const wallets = new MerchantWalletService(db.db);

  const address =
    arg('--address') ?? '0x1111111111111111111111111111111111111111';
  const chain = (arg('--chain') ?? config.pix.chain) as 'base' | 'polygon';

  try {
    const client = await clients.create({
      name: arg('--name') ?? 'Loja PIX teste',
      webhookUrl: arg('--webhook-url') ?? 'http://localhost:9999/webhook',
    });
    const wallet = await wallets.createUsdcSettlement({
      merchantId: client.id,
      address,
      chain,
      network: chain,
    });
    console.log(
      JSON.stringify(
        {
          merchant_id: client.id,
          api_key: client.apiKey,
          request_secret: client.requestSecret,
          webhook_secret: client.webhookSecret,
          settlement_wallet: wallet.address,
          chain,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error('[btc-payments] falha ao criar loja de PIX:', err);
  process.exit(1);
});
