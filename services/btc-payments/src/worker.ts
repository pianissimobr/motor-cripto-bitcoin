import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createRepositories } from './db/repositories.js';
import { createLogger } from './logger.js';
import { loadEnv } from './load-env.js';
import { EsploraClient } from './adapters/chain/esplora.js';
import { PaymentIntentService } from './services/payment-intent-service.js';
import { OnchainWatcher } from './services/onchain-watcher.js';
import { WebhookDeliveryService } from './services/webhook-delivery-service.js';
import { AlertService } from './services/alert-service.js';
import { LedgerService } from './ledger/ledger-service.js';
import { ReconciliationService } from './services/reconciliation-service.js';
import { LuniumClient } from './adapters/lunium/client.js';
import { PixChargeService } from './services/pix-charge-service.js';
import { CashOutService } from './services/cashout-service.js';
import { LuniumWebhookService } from './services/lunium-webhook-service.js';
import { SubscriptionService } from './services/subscription-service.js';
import { createLnbitsFactory } from './services/merchant-lightning.js';

export type WorkerHandle = {
  stop: () => Promise<void>;
};

type Job = {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
};

/**
 * Worker: prova os pagamentos na fonte (LNbits do lojista, Esplora, Lunium),
 * expira cobrancas, gera ciclos de assinatura e entrega webhooks. Nao move
 * dinheiro: nao ha sweep, conversao nem payout.
 */
export async function startWorker(): Promise<WorkerHandle> {
  loadEnv();
  const config = loadConfig();
  const logger = createLogger({
    level: config.server.logLevel,
    pretty: !config.service.isProduction,
  });

  const db = createDb(config.database);
  const repos = createRepositories(db.db);

  const esplora =
    config.onchain.enabled && config.esplora.url
      ? new EsploraClient({
          url: config.esplora.url,
          timeoutMs: config.esplora.timeoutMs,
          logger,
        })
      : null;

  const alerts = new AlertService({ ...config.alerts, logger });
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
  const onchainWatcher =
    config.onchain.enabled && esplora
      ? new OnchainWatcher({ repos, esplora, config, logger, alerts })
      : null;
  const webhookDelivery = new WebhookDeliveryService({ repos, config, logger });
  const ledger = new LedgerService(db.db);

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
            maxRequests: config.pix.rateLimit.workerMax,
            windowMs: config.pix.rateLimit.windowMs,
            maxQueue: config.pix.rateLimit.maxQueue,
          },
          catalogCacheMs: config.pix.catalogCacheMs,
          limitsCacheMs: config.pix.limitsCacheMs,
        })
      : null;
  const pixCharges = lunium
    ? new PixChargeService({ repos, lunium, config, logger, alerts })
    : null;
  const cashOut =
    lunium && config.cashout.enabled
      ? new CashOutService({ repos, lunium, config, logger, alerts })
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
  const reconciliationService = new ReconciliationService({
    repos,
    ledger,
    logger,
    alerts,
  });

  const batch = config.jobs.batchSize;
  const jobs: Job[] = [
    {
      name: 'expiry',
      intervalMs: config.jobs.expiryPollMs,
      run: () => paymentIntents.expireDueIntents(batch),
    },
    {
      name: 'webhook-delivery',
      intervalMs: config.jobs.webhookPollMs,
      run: async () => {
        const result = await webhookDelivery.runCycle(batch);
        const noncesRemovidos = await repos.cleanupExpiredNonces();
        return { ...result, noncesRemovidos };
      },
    },
  ];

  if (config.lightning.enabled || config.onchain.enabled) {
    jobs.push({
      name: 'subscription-charge',
      intervalMs: config.jobs.subscriptionMs,
      run: () => subscriptions.runCycle(batch),
    });
  }

  if (config.lightning.enabled) {
    jobs.push({
      name: 'lightning-reconcile',
      intervalMs: config.jobs.lightningReconcileMs,
      run: () => paymentIntents.reconcilePendingLightning(batch),
    });
  }

  if (onchainWatcher) {
    const watcher = onchainWatcher;
    jobs.push({
      name: 'onchain-watch',
      intervalMs: config.jobs.onchainPollMs,
      run: () => watcher.runCycle(batch),
    });
  }

  if (pixCharges) {
    const service = pixCharges;
    jobs.push({
      name: 'pix-reconcile',
      intervalMs: config.jobs.pixPollMs,
      run: () => service.reconcile(config.jobs.pixBatchSize),
    });
  }

  if (cashOut) {
    const service = cashOut;
    jobs.push({
      name: 'cashout-reconcile',
      intervalMs: config.jobs.pixPollMs,
      run: () => service.reconcile(config.jobs.pixBatchSize),
    });
  }

  if (luniumWebhook) {
    const service = luniumWebhook;
    jobs.push({
      name: 'lunium-inbox',
      intervalMs: config.jobs.pixPollMs,
      run: () => service.processPending(batch),
    });
  }

  jobs.push({
    name: 'reconciliation',
    intervalMs: config.jobs.reconciliationMs,
    run: () => reconciliationService.runCycle(),
  });

  logger.info(
    {
      network: config.btc.network,
      lightning: config.lightning.enabled,
      onchain: config.onchain.enabled,
      pix: config.pix.enabled,
      jobs: jobs.map((job) => ({ name: job.name, intervalMs: job.intervalMs })),
    },
    'worker btc-payments iniciado',
  );

  const running = new Set<string>();
  const runJob = async (job: Job): Promise<void> => {
    if (running.has(job.name)) return;
    running.add(job.name);
    try {
      const result = await job.run();
      logger.debug({ job: job.name, result }, 'job concluido');
    } catch (err) {
      logger.error({ err, job: job.name }, 'job falhou');
      await alerts.send({
        level: 'error',
        title: 'job do worker falhou',
        message: job.name,
        metadata: {
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      running.delete(job.name);
    }
  };

  const timers: NodeJS.Timeout[] = [];
  for (const job of jobs) {
    timers.push(setInterval(() => void runJob(job), job.intervalMs));
    void runJob(job);
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    logger.info('encerrando worker');
    await db.close();
  };

  process.on('SIGINT', () => {
    void stop().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void stop().then(() => process.exit(0));
  });

  return { stop };
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startWorker().catch((err) => {
    console.error('[btc-payments] falha ao iniciar worker:', err);
    process.exit(1);
  });
}
