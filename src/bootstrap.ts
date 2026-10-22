import pino, { type Logger as PinoLogger } from 'pino';
import { loadEnvFile } from './load-env.js';
import { createDatabase, type DatabaseHandle } from './adapters/db/client.js';
import { createRepositories } from './adapters/db/repositories.js';
import { CHAINS } from './core/chain/chains.js';
import { createProviderFactory } from './core/chain/provider.js';
import { GasSponsor } from './core/chain/gas-sponsor.js';
import { loadConfig, type AppConfig } from './core/config.js';
import { HdWallet } from './core/hd/hd-wallet.js';
import { createMotor, type Motor } from './core/index.js';
import { LocalSigner } from './core/signer/local-signer.js';
import { PsbtSigner } from './core/signer/psbt-signer.js';
import { RemoteSigner } from './core/signer/remote-signer.js';
import type { Signer } from './core/signer/signer.js';
import type { Logger } from './core/logger.js';

/**
 * Montagem do motor: config -> infra -> core.
 * Compartilhado entre o servidor HTTP e o worker, para que ambos usem
 * exatamente a mesma configuracao e os mesmos ports.
 */

export type Bootstrap = {
  config: AppConfig;
  logger: Logger;
  db: DatabaseHandle;
  motor: Motor;
  signer: Signer;
  close: () => Promise<void>;
};

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<Bootstrap> {
  loadEnvFile();
  const config = loadConfig(env);
  const logger = createLogger(config);

  const db = createDatabase(config.database.url, config.database.ssl);
  const repos = createRepositories(db.db);

  const hdWallet = HdWallet.fromAccountXpub(
    config.hd.xpub,
    config.hd.derivationPrefix,
    config.hd.accountIndex,
  );

  const signer = createSigner(config, hdWallet, logger);

  const rpcUrls: Record<string, string> = {};
  for (const [chain, spec] of Object.entries(CHAINS)) {
    const url = env[spec.rpcEnvKey];
    if (url) rpcUrls[chain] = url;
  }
  const providerFactory = createProviderFactory(rpcUrls);

  const gasSponsor = new GasSponsor(
    config.gasSponsor.privateKey,
    config.gasSponsor.amountWei,
    config.gasSponsor.minBalanceWei,
  );

  const motor = createMotor({
    repos,
    hdWallet,
    signer,
    providerFactory,
    gasSponsor,
    logger,
    dataKey: config.crypto.dataKey,
    indexKey: config.crypto.indexKey,
    ttlHours: config.links.ttlHours,
    monitor: {
      confirmationsRequired: config.chain.confirmationsRequired,
      tolerancePct: config.chain.tolerancePct,
      maxTopics: config.chain.maxTopics,
      blockRange: config.chain.blockRange,
      startBlock: config.chain.startBlock,
      blockTag: config.chain.blockTag,
      anchorInterval: config.chain.anchorInterval,
    },
    sweeper: {
      gasSponsorAmountWei: config.gasSponsor.amountWei,
      gasSponsorMinBalanceWei: config.gasSponsor.minBalanceWei,
      batchSize: 10,
    },
  });

  return {
    config,
    logger,
    db,
    motor,
    signer,
    close: async () => {
      await db.close();
    },
  };
}

function createSigner(config: AppConfig, hdWallet: HdWallet, logger: Logger): Signer {
  switch (config.signer.mode) {
    case 'local': {
      const passphrase = config.signer.passphrase;
      if (!passphrase) {
        throw new Error(
          'SIGNER_PASSPHRASE obrigatorio no modo local (senha do keystore cifrado)',
        );
      }
      const signer = LocalSigner.fromKeystoreFile(config.signer.keystorePath, passphrase);
      logger.info({ signer: signer.describe() }, 'signer local carregado');
      return signer;
    }
    case 'remote': {
      if (!config.signer.remoteUrl) {
        throw new Error('SIGNER_REMOTE_URL obrigatorio no modo remote');
      }
      const signer = new RemoteSigner({
        url: config.signer.remoteUrl,
        token: config.signer.remoteToken,
        resolveAddress: (index) => hdWallet.deriveAddress(index),
      });
      logger.info({ signer: signer.describe() }, 'signer remoto configurado');
      return signer;
    }
    case 'psbt': {
      const signer = new PsbtSigner((index) => hdWallet.deriveAddress(index));
      logger.info({ signer: signer.describe() }, 'assinatura manual habilitada');
      return signer;
    }
  }
}

function createLogger(config: AppConfig): Logger {
  const pinoLogger: PinoLogger = pino({
    level: config.server.logLevel,
    redact: {
      paths: [
        'xpub',
        'xprv',
        'seed',
        'mnemonic',
        'passphrase',
        'hostApiKey',
        'host_api_key',
        'rampUrl',
        'ramp_url',
        '*.xpub',
        '*.seed',
        '*.passphrase',
        '*.rampUrl',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[REDACTED]',
    },
    transport:
      config.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
  });
  return pinoLogger as unknown as Logger;
}
