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
import { AuthService } from './services/auth-service.js';
import { NoopEmailSender } from './services/email-sender.js';
import { PaymentIntentService } from './services/payment-intent-service.js';
import { ensureDefaultWallets } from './services/merchant-wallet-service.js';
import { FxService } from './services/fx-service.js';
import { HttpFxPriceProvider } from './adapters/fx/http.js';
import { LedgerService } from './ledger/ledger-service.js';
import { MerchantWalletService } from './services/merchant-wallet-service.js';
import { ConversionService } from './services/conversion-service.js';
import { PayoutService } from './services/payout-service.js';
import { ThorchainClient } from './adapters/conversion/thorchain.js';
import { createTreasuryBtcSender } from './adapters/conversion/btc-treasury.js';
import { createUsdcPayoutAdapter } from './adapters/payout/base-usdc.js';
import { MetricsService } from './services/metrics-service.js';
import { LuniumClient } from './adapters/lunium/client.js';
import { PixChargeService } from './services/pix-charge-service.js';
import { LuniumWebhookService } from './services/lunium-webhook-service.js';
import { ReportService } from './services/report-service.js';
import { SubscriptionService } from './services/subscription-service.js';

export async function main(): Promise<void> {
  loadEnv();
  const config = loadConfig();
  const logger = createLogger({
    level: config.server.logLevel,
    pretty: !config.service.isProduction,
  });

  const xpub =
    config.onchain.enabled && config.btc.xpub
      ? parseConfiguredXpub(config.btc.xpub, config.btc.network)
      : null;
  const treasuryBtcAddress =
    config.treasury.btcAddress ?? config.sweep.coldWalletAddress;
  if (config.sweep.enabled) {
    assertAddress(treasuryBtcAddress!, config.btc.network);
  }

  const db = createDb(config.database);
  const repos = createRepositories(db.db);

  try {
    if (xpub) {
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
    }
    await ensureDefaultWallets(db.db, {
      ...(xpub && config.btc.xpub
        ? { xpub: config.btc.xpub, xpubFingerprint: xpub.fingerprint }
        : {}),
      derivationPrefix: config.btc.derivationPrefix,
      network: config.btc.network,
      gapLimit: config.btc.gapLimit,
      ...(config.treasury.btcAddress ?? config.sweep.coldWalletAddress
        ? {
            coldWalletAddress:
              config.treasury.btcAddress ?? config.sweep.coldWalletAddress,
          }
        : {}),
      ...(config.treasury.btcAddress
        ? { treasuryBtcAddress: config.treasury.btcAddress }
        : {}),
      ...(config.treasury.usdcBaseAddress
        ? { treasuryUsdcAddress: config.treasury.usdcBaseAddress }
        : {}),
      ...(config.treasury.gasBaseAddress
        ? { gasBaseAddress: config.treasury.gasBaseAddress }
        : {}),
    });

    const lnbits =
      config.lightning.enabled &&
      config.lightning.url &&
      config.lightning.apiKey
        ? new LnbitsClient({
            url: config.lightning.url,
            apiKey: config.lightning.apiKey,
            timeoutMs: 10_000,
            logger,
          })
        : null;
    const esplora =
      config.onchain.enabled && config.esplora.url
        ? new EsploraClient({
            url: config.esplora.url,
            timeoutMs: config.esplora.timeoutMs,
            logger,
          })
        : null;

    const lunium =
      config.pix.enabled && config.pix.luniumApiKey
        ? new LuniumClient({
            apiUrl: config.pix.luniumApiUrl,
            apiKey: config.pix.luniumApiKey,
            ...(config.pix.luniumWebhookSecret
              ? { webhookSecret: config.pix.luniumWebhookSecret }
              : {}),
            timeoutMs: config.pix.timeoutMs,
          })
        : null;

    const readiness = createReadiness({
      network: config.btc.network,
      ...(xpub ? { xpub } : {}),
      ...(config.treasury.btcAddress ?? config.sweep.coldWalletAddress
        ? {
            coldWalletAddress:
              config.treasury.btcAddress ?? config.sweep.coldWalletAddress,
          }
        : {}),
      sweepEnabled: config.sweep.enabled,
      lightningEnabled: config.lightning.enabled,
      onchainEnabled: config.onchain.enabled,
      repos,
      ...(lnbits ? { lnbits } : {}),
      ...(esplora ? { esplora } : {}),
      ...(lunium ? { lunium } : {}),
    });

    const clients = new ClientService({ repos, config, logger });
    const alerts = new AlertService({ ...config.alerts, logger });
    const auth = new AuthService({
      repos,
      clients,
      config,
      logger,
      emailSender: new NoopEmailSender(logger),
    });
    const fx = new FxService(
      db.db,
      new HttpFxPriceProvider({ timeoutMs: config.esplora.timeoutMs }),
    );
    const ledger = new LedgerService(db.db);
    const wallets = new MerchantWalletService(db.db);
    const metrics = new MetricsService({ repos, ledger });
    const reports = new ReportService({ db: db.db });
    const conversions = config.conversion.enabled && config.onchain.enabled
      ? new ConversionService({
          repos,
          ledger,
          swap: new ThorchainClient({
            urls: config.conversion.thorchainUrls,
            usdcAddress: config.payout.usdcAddress,
            timeoutMs: config.conversion.timeoutMs,
            quoteToleranceBps: config.conversion.quoteToleranceBps,
          }),
          sender: createTreasuryBtcSender(config),
          config,
          logger,
          alerts,
        })
      : null;
    const payouts = config.payout.enabled
      ? new PayoutService({
          repos,
          ledger,
          adapter: createUsdcPayoutAdapter(config),
          config,
          logger,
          alerts,
        })
      : null;
    const paymentIntents = new PaymentIntentService({
      repos,
      lnbits,
      config,
      xpub,
      logger,
      alerts,
    });
    const subscriptions = new SubscriptionService({
      repos,
      paymentIntents,
      logger,
      alerts,
    });
    const pixCharges = lunium
      ? new PixChargeService({
          repos,
          ledger,
          lunium,
          config,
          logger,
          alerts,
        })
      : null;
    const luniumWebhook = pixCharges && lunium
      ? new LuniumWebhookService({
          repos,
          lunium,
          pixCharges,
          config,
          logger,
          alerts,
        })
      : null;

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
        auth,
        fx,
        ledger,
        wallets,
        metrics,
        reports,
        subscriptions,
        ...(conversions ? { conversions } : {}),
        ...(payouts ? { payouts } : {}),
        ...(pixCharges ? { pixCharges } : {}),
        ...(luniumWebhook ? { luniumWebhook } : {}),
        ...(esplora ? { esplora } : {}),
        getStatus: async () => {
          const [counts, lnbitsHealth, esploraHealth] = await Promise.all([
            repos.getStatusCounts(),
            lnbits ? lnbits.health() : Promise.resolve(null),
            esplora ? esplora.health() : Promise.resolve(null),
          ]);
          return {
            ok: true,
            ...counts,
            lnbits: lnbitsHealth,
            esplora: esploraHealth,
            network: config.btc.network,
            xpubFingerprint: xpub?.fingerprint ?? null,
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
        xpubFingerprint: xpub?.fingerprint ?? null,
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
