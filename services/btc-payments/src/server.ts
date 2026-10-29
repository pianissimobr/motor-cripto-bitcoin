import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createRepositories } from './db/repositories.js';
import { buildApp } from './http/app.js';
import { createLogger } from './logger.js';
import { loadEnv } from './load-env.js';
import { createReadiness, parseConfiguredXpub } from './readiness.js';
import { LnbitsClient } from './adapters/lnbits/client.js';
import { EsploraClient } from './adapters/chain/esplora.js';
import { assertAddress } from './adapters/hd/derivation.js';
import { ClientService } from './services/client-service.js';
import { AlertService } from './services/alert-service.js';
import { PaymentIntentService } from './services/payment-intent-service.js';

export async function main(): Promise<void> {
  loadEnv();
  const config = loadConfig();
  const logger = createLogger({
    level: config.server.logLevel,
    pretty: !config.service.isProduction,
  });

  const xpub = parseConfiguredXpub(config.btc.xpub, config.btc.network);
  if (config.sweep.enabled) {
    assertAddress(config.sweep.coldWalletAddress!, config.btc.network);
  }

  const db = createDb(config.database);
  const repos = createRepositories(db.db);

  try {
    await repos.initHdWalletState({
      gapLimit: config.btc.gapLimit,
      xpubFingerprint: xpub.fingerprint,
    });
    const state = await repos.getHdWalletState();
    if (state && state.xpubFingerprint !== xpub.fingerprint) {
      throw new Error(
        'BTC_XPUB nao corresponde ao fingerprint gravado no banco. ' +
          'Restaure o xpub original ou faça uma migracao consciente.',
      );
    }

    const lnbits = new LnbitsClient({
      url: config.lightning.url,
      apiKey: config.lightning.apiKey,
      timeoutMs: 10_000,
      logger,
    });
    const esplora = new EsploraClient({
      url: config.esplora.url,
      timeoutMs: config.esplora.timeoutMs,
      logger,
    });

    const readiness = createReadiness({
      network: config.btc.network,
      xpub,
      ...(config.sweep.coldWalletAddress
        ? { coldWalletAddress: config.sweep.coldWalletAddress }
        : {}),
      sweepEnabled: config.sweep.enabled,
      repos,
      lnbits,
      esplora,
    });

    const clients = new ClientService({ repos, config, logger });
    const alerts = new AlertService({ ...config.alerts, logger });
    const paymentIntents = new PaymentIntentService({
      repos,
      lnbits,
      config,
      xpub,
      logger,
      alerts,
    });

    const app = buildApp({
      config,
      logger,
      readiness,
      services: {
        config,
        logger,
        repos,
        paymentIntents,
        clients,
        esplora,
        getStatus: async () => {
          const [counts, lnbitsHealth, esploraHealth] = await Promise.all([
            repos.getStatusCounts(),
            lnbits.health(),
            esplora.health(),
          ]);
          return {
            ok: true,
            ...counts,
            lnbits: lnbitsHealth,
            esplora: esploraHealth,
            network: config.btc.network,
            xpubFingerprint: xpub.fingerprint,
            signerMode: config.signer.mode,
            sweepEnabled: config.sweep.enabled,
            uptimeSeconds: Math.round(process.uptime()),
          };
        },
      },
    });
    await app.listen({ port: config.server.port, host: config.server.host });

    logger.info(
      {
        port: config.server.port,
        host: config.server.host,
        network: config.btc.network,
        xpubFingerprint: xpub.fingerprint,
        sweepEnabled: config.sweep.enabled,
      },
      'btc-payments API no ar',
    );

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'encerrando API');
      try {
        await app.close();
      } finally {
        await db.close();
      }
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (err) {
    await db.close();
    throw err;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error('[btc-payments] falha ao iniciar:', err);
    process.exit(1);
  });
}
