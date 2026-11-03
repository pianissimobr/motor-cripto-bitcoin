import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createRepositories } from './db/repositories.js';
import { buildApp } from './http/app.js';
import { createLogger } from './logger.js';
import { loadEnv } from './load-env.js';
import { createReadiness } from './readiness.js';
import { EsploraClient } from './adapters/chain/esplora.js';
import { ClientService } from './services/client-service.js';
import { AlertService } from './services/alert-service.js';
import { AuthService } from './services/auth-service.js';
import { NoopEmailSender } from './services/email-sender.js';
import { SmtpEmailSender } from './services/smtp-email-sender.js';
import { PaymentIntentService } from './services/payment-intent-service.js';
import { FxService } from './services/fx-service.js';
import { MarketService } from './services/market-service.js';
import { HttpFxPriceProvider } from './adapters/fx/http.js';
import { LedgerService } from './ledger/ledger-service.js';
import { MerchantWalletService } from './services/merchant-wallet-service.js';
import { createLnbitsFactory } from './services/merchant-lightning.js';
import { MetricsService } from './services/metrics-service.js';
import { LuniumClient } from './adapters/lunium/client.js';
import { PixChargeService } from './services/pix-charge-service.js';
import { LuniumWebhookService } from './services/lunium-webhook-service.js';
import { ReportService } from './services/report-service.js';
import { SubscriptionService } from './services/subscription-service.js';
import { WalletChangeNotifier } from './services/wallet-change-notifier.js';
import { AuthoIssuerClient } from './adapters/autho/client.js';

/**
 * API do motor. O dinheiro nao passa pela plataforma: Lightning cai na
 * wallet LNbits do lojista, on-chain nos enderecos do xpub dele e PIX vira
 * USDC na carteira Base dele. A API cria cobrancas, prova pagamentos e avisa.
 */
export async function main(): Promise<void> {
  loadEnv();
  const config = loadConfig();
  const logger = createLogger({
    level: config.server.logLevel,
    pretty: !config.service.isProduction,
  });

  const db = createDb(config.database);
  const repos = createRepositories(db.db);

  try {
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
            rateLimit: {
              maxRequests: config.pix.rateLimit.apiMax,
              windowMs: config.pix.rateLimit.windowMs,
              maxQueue: config.pix.rateLimit.maxQueue,
            },
            catalogCacheMs: config.pix.catalogCacheMs,
            limitsCacheMs: config.pix.limitsCacheMs,
          })
        : null;

    const readiness = createReadiness({
      onchainEnabled: config.onchain.enabled,
      repos,
      ...(esplora ? { esplora } : {}),
      ...(lunium ? { lunium } : {}),
    });

    const clients = new ClientService({ repos, config, logger });
    const alerts = new AlertService({ ...config.alerts, logger });
    const emailSender =
      config.email.sender === 'smtp' && config.email.smtp && config.email.from
        ? new SmtpEmailSender({
            smtp: config.email.smtp,
            from: config.email.from,
            publicBaseUrl: config.service.publicBaseUrl,
            logger,
          })
        : new NoopEmailSender(logger);
    if (config.email.sender === 'noop') {
      logger.warn(
        {},
        'e-mail desativado (EMAIL_SENDER=noop): token de redefinicao de senha e aviso de troca de carteira nao chegam ao lojista',
      );
    }
    // authO issuer: codigos por e-mail e anti-robo. Sem ele, o portal usa
    // tokens locais (so desenvolvimento).
    const autho = config.autho ? new AuthoIssuerClient(config.autho) : undefined;
    const auth = new AuthService({
      repos,
      clients,
      config,
      logger,
      emailSender,
      ...(autho ? { autho } : {}),
    });
    const walletNotifier = new WalletChangeNotifier({ repos, logger, alerts, emailSender });
    const fx = new FxService(
      db.db,
      new HttpFxPriceProvider({ timeoutMs: config.esplora.timeoutMs }),
    );
    const market = new MarketService({ logger });
    const ledger = new LedgerService(db.db);
    const wallets = new MerchantWalletService(db.db);
    const metrics = new MetricsService({
      repos,
      ledger,
      ...(lunium ? { luniumLimiter: lunium.rateLimiter } : {}),
    });
    const reports = new ReportService({ db: db.db });
    const lnbitsFor = config.lightning.enabled
      ? createLnbitsFactory(config, logger)
      : null;
    const paymentIntents = new PaymentIntentService({
      repos,
      lnbitsFor,
      config,
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
      ? new PixChargeService({ repos, lunium, config, logger, alerts })
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
        market,
        ledger,
        wallets,
        metrics,
        reports,
        subscriptions,
        ...(lnbitsFor ? { lnbitsFor } : {}),
        walletNotifier,
        ...(autho ? { autho } : {}),
        ...(pixCharges ? { pixCharges } : {}),
        ...(luniumWebhook ? { luniumWebhook } : {}),
        getStatus: async () => {
          const [counts, esploraHealth] = await Promise.all([
            repos.getStatusCounts(),
            esplora ? esplora.health() : Promise.resolve(null),
          ]);
          return {
            ok: true,
            ...counts,
            esplora: esploraHealth,
            network: config.btc.network,
            rails: {
              lightning: config.lightning.enabled,
              onchain: config.onchain.enabled,
              pix: config.pix.enabled,
            },
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
        lightning: config.lightning.enabled,
        onchain: config.onchain.enabled,
        pix: config.pix.enabled,
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
