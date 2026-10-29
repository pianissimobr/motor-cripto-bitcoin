import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createRepositories } from './db/repositories.js';
import { createLogger } from './logger.js';
import { loadEnv } from './load-env.js';
import { parseConfiguredXpub } from './readiness.js';
import { LnbitsClient } from './adapters/lnbits/client.js';
import { EsploraClient } from './adapters/chain/esplora.js';
import { assertAddress } from './adapters/hd/derivation.js';
import { PaymentIntentService } from './services/payment-intent-service.js';
import { OnchainWatcher } from './services/onchain-watcher.js';
import { WebhookDeliveryService } from './services/webhook-delivery-service.js';
import { SweepService } from './services/sweep-service.js';
import { createSweepSigner } from './adapters/signer/factory.js';
import { AlertService } from './services/alert-service.js';

export type WorkerHandle = {
  stop: () => Promise<void>;
};

type Job = {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
};

export async function startWorker(): Promise<WorkerHandle> {
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
  await repos.initHdWalletState({
    gapLimit: config.btc.gapLimit,
    xpubFingerprint: xpub.fingerprint,
  });
  const state = await repos.getHdWalletState();
  if (state && state.xpubFingerprint !== xpub.fingerprint) {
    await db.close();
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

  const alerts = new AlertService({ ...config.alerts, logger });
  const paymentIntents = new PaymentIntentService({
    repos,
    lnbits,
    config,
    xpub,
    logger,
    alerts,
  });
  const onchainWatcher = new OnchainWatcher({
    repos,
    esplora,
    config,
    logger,
    alerts,
  });
  const webhookDelivery = new WebhookDeliveryService({
    repos,
    config,
    logger,
  });

  let sweepService: SweepService | null = null;
  if (config.sweep.enabled) {
    try {
      const signer = createSweepSigner(config);
      signer.verifyMatches?.(xpub, config.btc.network, config.btc.derivationPrefix);
      sweepService = new SweepService({
        repos,
        esplora,
        signer,
        config,
        logger,
        alerts,
      });
    } catch (err) {
      logger.warn(
        { err },
        'sweep desabilitado: keystore/signer indisponivel (rode wallet:init)',
      );
    }
  }

  const batch = config.jobs.batchSize;
  const jobs: Job[] = [
    {
      name: 'lightning-reconcile',
      intervalMs: config.jobs.lightningReconcileMs,
      run: () => paymentIntents.reconcilePendingLightning(batch),
    },
    {
      name: 'expiry',
      intervalMs: config.jobs.expiryPollMs,
      run: () => paymentIntents.expireDueIntents(batch),
    },
    {
      name: 'onchain-watch',
      intervalMs: config.jobs.onchainPollMs,
      run: () => onchainWatcher.runCycle(batch),
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

  if (sweepService) {
    const service = sweepService;
    jobs.push({
      name: 'sweep',
      intervalMs: config.jobs.sweepPollMs,
      run: () => service.runCycle(batch),
    });
  }

  logger.info(
    {
      network: config.btc.network,
      xpubFingerprint: xpub.fingerprint,
      signerMode: config.signer.mode,
      sweepEnabled: config.sweep.enabled,
      sweepJob: Boolean(sweepService),
      jobs: jobs.map((job) => ({ name: job.name, intervalMs: job.intervalMs })),
    },
    'worker btc-payments iniciado',
  );

  if (config.signer.mode === 'local' && !config.signer.passphrase) {
    logger.warn(
      'SIGNER_MODE=local sem SIGNER_PASSPHRASE; o sweep nao conseguira assinar ate configurar o keystore',
    );
  }

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
