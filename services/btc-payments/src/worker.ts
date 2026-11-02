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
import { ensureDefaultWallets } from './services/merchant-wallet-service.js';
import { LedgerService } from './ledger/ledger-service.js';
import { ThorchainClient } from './adapters/conversion/thorchain.js';
import { createTreasuryBtcSender } from './adapters/conversion/btc-treasury.js';
import { createLightningTreasuryWithdrawal } from './adapters/conversion/lnbits-withdrawal.js';
import { ConversionService } from './services/conversion-service.js';
import { TreasuryService } from './services/treasury-service.js';
import { PayoutService } from './services/payout-service.js';
import { createUsdcPayoutAdapter } from './adapters/payout/base-usdc.js';
import { ReconciliationService } from './services/reconciliation-service.js';
import { LuniumClient } from './adapters/lunium/client.js';
import { PixChargeService } from './services/pix-charge-service.js';
import { LuniumWebhookService } from './services/lunium-webhook-service.js';
import { SubscriptionService } from './services/subscription-service.js';

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
  if (xpub) {
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
    config.lightning.enabled && config.lightning.url && config.lightning.apiKey
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

  const alerts = new AlertService({ ...config.alerts, logger });
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
  const onchainWatcher =
    config.onchain.enabled && esplora
      ? new OnchainWatcher({
          repos,
          esplora,
          config,
          logger,
          alerts,
        })
      : null;
  const webhookDelivery = new WebhookDeliveryService({
    repos,
    config,
    logger,
  });
  const ledger = new LedgerService(db.db);

  const conversionService = config.conversion.enabled && config.onchain.enabled
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
  const treasuryService = config.conversion.enabled && config.onchain.enabled
    ? new TreasuryService({
        repos,
        withdrawal: createLightningTreasuryWithdrawal(config),
        config,
        logger,
        alerts,
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
  const reconciliationService = new ReconciliationService({
    repos,
    ledger,
    logger,
    alerts,
  });
  const payoutService = config.payout.enabled
    ? new PayoutService({
        repos,
        ledger,
        adapter: createUsdcPayoutAdapter(config),
        config,
        logger,
        alerts,
      })
    : null;

  let sweepService: SweepService | null = null;
  if (config.sweep.enabled && xpub && esplora) {
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

  if (sweepService) {
    const service = sweepService;
    jobs.push({
      name: 'sweep',
      intervalMs: config.jobs.sweepPollMs,
      run: () => service.runCycle(batch),
    });
  }

  if (treasuryService) {
    const service = treasuryService;
    jobs.push({
      name: 'treasury-withdrawal',
      intervalMs: config.jobs.conversionPollMs,
      run: () => service.runCycle(batch),
    });
  }

  if (conversionService) {
    const service = conversionService;
    jobs.push({
      name: 'conversion',
      intervalMs: config.jobs.conversionPollMs,
      run: () => service.runCycle(batch),
    });
  }

  if (payoutService) {
    const service = payoutService;
    jobs.push({
      name: 'payout',
      intervalMs: config.jobs.payoutPollMs,
      run: () => service.runCycle(batch),
    });
  }

  if (pixCharges) {
    const service = pixCharges;
    jobs.push({
      name: 'pix-reconcile',
      intervalMs: config.jobs.pixPollMs,
      run: () => service.reconcile(batch),
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
      xpubFingerprint: xpub?.fingerprint ?? null,
      signerMode: config.signer.mode,
      sweepEnabled: config.sweep.enabled,
      sweepJob: Boolean(sweepService),
      conversionEnabled: config.conversion.enabled,
      payoutEnabled: config.payout.enabled,
      treasuryBtcSigner: config.conversion.treasuryBtcSignerUrl ? 'remote' : 'manual',
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
