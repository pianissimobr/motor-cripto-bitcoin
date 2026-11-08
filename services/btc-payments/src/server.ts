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
import { NoopEmailSender } from './services/email-sender.js';
import { SmtpEmailSender } from './services/smtp-email-sender.js';
import { GasStationService } from './services/gas-station-service.js';
import { PaymentIntentService } from './services/payment-intent-service.js';
import { FxService } from './services/fx-service.js';
import {
  CachedFxPriceProvider,
  HttpFxPriceProvider,
} from './adapters/fx/http.js';
import { LedgerService } from './ledger/ledger-service.js';
import { MerchantWalletService } from './services/merchant-wallet-service.js';
import { createLnbitsFactory } from './services/merchant-lightning.js';
import { MetricsService } from './services/metrics-service.js';
import { LuniumClient } from './adapters/lunium/client.js';
import { SwapKitClient } from './adapters/swapkit/client.js';
import { PixChargeService } from './services/pix-charge-service.js';
import { LuniumLimits } from './services/lunium-limits.js';
import { SwapService } from './services/swap-service.js';
import { PaymentRequestService } from './services/payment-request-service.js';
import { CashOutService } from './services/cashout-service.js';
import { AuthoIssuerClient } from './adapters/autho/client.js';
import { DashAuthService } from './services/dash-auth-service.js';
import { DashService } from './services/dash-service.js';
import { InvoiceService } from './services/invoice-service.js';
import { PixDiretoService } from './services/pix-direto-service.js';
import { NuvemshopService } from './services/nuvemshop-service.js';
import { BlingService } from './services/bling-service.js';
import { createDashQueries } from './db/dash-queries.js';
import { LuniumWebhookService } from './services/lunium-webhook-service.js';
import { SubscriptionService } from './services/subscription-service.js';
import { WalletChangeNotifier } from './services/wallet-change-notifier.js';
import { DeviceClientService } from './services/device-client-service.js';
import { OperationsService } from './services/operations-service.js';
import { FlagsService } from './services/flags-service.js';

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

    const swapkit =
      config.swapkit.enabled && config.swapkit.apiKey
        ? new SwapKitClient({
            apiUrl: config.swapkit.apiUrl,
            apiKey: config.swapkit.apiKey,
            timeoutMs: config.swapkit.timeoutMs,
            rateLimit: {
              maxRequests: config.swapkit.rateLimit.apiMax,
              windowMs: config.swapkit.rateLimit.windowMs,
              maxQueue: config.swapkit.rateLimit.maxQueue,
            },
          })
        : null;

    const readiness = createReadiness({
      onchainEnabled: config.onchain.enabled,
      repos,
      ...(esplora ? { esplora } : {}),
      ...(lunium ? { lunium } : {}),
      ...(swapkit ? { swapkit } : {}),
    });

    const clients = new ClientService({ repos, config, logger });
    const alerts = new AlertService({
      ...config.alerts,
      logger,
      ...(config.email.smtp ? { smtp: config.email.smtp } : {}),
      ...(config.email.from ? { emailFrom: config.email.from } : {}),
    });
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
        'e-mail desativado (EMAIL_SENDER=noop): o aviso de troca de carteira nao chega ao lojista',
      );
    }
    const walletNotifier = new WalletChangeNotifier({ repos, logger, alerts, emailSender });
    // Com cache: as fontes de taxa sao publicas e tem cota propria (a
    // AwesomeAPI responde 429 com frequencia), e uma rajada de cobrancas
    // nao pode virar uma rajada de requisicoes.
    const fxPrices = new CachedFxPriceProvider(
      new HttpFxPriceProvider({ timeoutMs: config.esplora.timeoutMs }),
      config.fx.priceCacheMs,
    );
    const fx = new FxService(db.db, fxPrices);
    const ledger = new LedgerService(db.db);
    const wallets = new MerchantWalletService(db.db);
    const metrics = new MetricsService({
      repos,
      ledger,
      ...(lunium ? { luniumLimiter: lunium.rateLimiter } : {}),
    });
    const gasStation = new GasStationService({ repos, config, logger });
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
    // Limites vigentes da chave na Lunium (GET /keys/me), 10 min em cache.
    const liveLimits = lunium
      ? new LuniumLimits({ lunium, logger, asset: config.pix.asset, network: config.settlement.chain })
      : undefined;
    const pixCharges = lunium
      ? new PixChargeService({ repos, lunium, config, logger, alerts, ...(liveLimits ? { liveLimits } : {}) })
      : null;
    const swap = swapkit
      ? new SwapService({
          repos,
          swapkit,
          config,
          logger,
          alerts,
          fx,
          ...(esplora ? { esplora } : {}),
        })
      : null;
    const flags = new FlagsService({ repos, logger });
    const cashOut =
      lunium && config.cashout.enabled
        ? new CashOutService({ repos, lunium, config, logger, alerts, flags, ...(liveLimits ? { liveLimits } : {}) })
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

    const paymentRequests = new PaymentRequestService({
      repos,
      config,
      logger,
      ...(pixCharges ? { pixCharges } : {}),
      ...(swap ? { swap } : {}),
    });
    const deviceClients = new DeviceClientService({ repos, config, logger });
    const operations = new OperationsService({ repos, logger });

    // Painel do lojista: so existe com DASHBOARD_ENABLED=true.
    const autho = config.dashboard.autho ? new AuthoIssuerClient(config.dashboard.autho) : undefined;
    const dashAuth = config.dashboard.enabled
      ? new DashAuthService({ repos, clients, config, logger, emailSender, ...(autho ? { autho } : {}) })
      : undefined;
    const pixDireto = new PixDiretoService({ db: db.db, repos, config, logger });
    const invoices = new InvoiceService({
      db: db.db,
      repos,
      config,
      logger,
      prices: fxPrices,
      pixDireto,
      ...(pixCharges ? { pixCharges } : {}),
      ...(swap ? { swap } : {}),
    });
    const nuvemshop = new NuvemshopService({ db: db.db, repos, config, logger, invoices });
    const bling = new BlingService({ db: db.db, repos, config, logger });
    const dash = dashAuth
      ? new DashService({
          config,
          logger,
          repos,
          queries: createDashQueries(db.db),
          db: db.db,
          clients,
          auth: dashAuth,
          emailSender,
          ...(pixCharges ? { pixCharges } : {}),
          ...(swap ? { swap } : {}),
          paymentRequests,
        })
      : undefined;

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
        fx,
        ledger,
        wallets,
        metrics,
        gasStation,
        subscriptions,
        deviceClients,
        operations,
        flags,
        ...(lnbitsFor ? { lnbitsFor } : {}),
        walletNotifier,
        emailSender,
        ...(dashAuth ? { dashAuth } : {}),
        ...(dash ? { dash } : {}),
        invoices,
        pixDireto,
        nuvemshop,
        bling,
        ...(autho ? { autho } : {}),
        ...(pixCharges ? { pixCharges } : {}),
        ...(swap ? { swap } : {}),
        paymentRequests,
        ...(cashOut ? { cashOut } : {}),
        ...(luniumWebhook ? { luniumWebhook } : {}),
        ...(lunium ? { lunium } : {}),
        getStatus: async () => {
          const [counts, esploraHealth, gasStatus] = await Promise.all([
            repos.getStatusCounts(),
            esplora ? esplora.health() : Promise.resolve(null),
            gasStation.status(),
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
            gasStation: gasStatus,
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
