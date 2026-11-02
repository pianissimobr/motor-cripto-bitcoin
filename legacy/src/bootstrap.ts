import pino, { type Logger as PinoLogger } from 'pino';
import { loadEnvFile } from './load-env.js';
import { createDatabase, type DatabaseHandle } from './adapters/db/client.js';
import { createRepositories } from './adapters/db/repositories.js';
import { CHAINS } from './core/chain/chains.js';
import { createProviderFactory } from './core/chain/provider.js';
import { GasSponsor } from './core/chain/gas-sponsor.js';
import { loadConfig, type AppConfig } from './core/config.js';
import { HdWallet } from './core/hd/hd-wallet.js';
import { DataCipher, Keyring } from './core/crypto/cipher.js';
import { createMotor, type Motor } from './core/index.js';
import { AddressOnlySigner } from './core/signer/address-signer.js';
import { LocalSigner } from './core/signer/local-signer.js';
import { PsbtSigner } from './core/signer/psbt-signer.js';
import { RemoteSigner } from './core/signer/remote-signer.js';
import type { Signer } from './core/signer/signer.js';
import type { Logger } from './core/logger.js';

/**
 * Montagem do motor: config -> infra -> core.
 *
 * `api` nao abre o keystore, nao guarda a chave do gas sponsor e nao guarda
 * o token do signer remoto. `worker` e o unico papel que assina.
 */

export type BootstrapRole = 'api' | 'worker';

export type Bootstrap = {
  config: AppConfig;
  logger: Logger;
  db: DatabaseHandle;
  motor: Motor;
  signer: Signer;
  close: () => Promise<void>;
};

const SECRET_ENV = ['GAS_SPONSOR_PRIVATE_KEY', 'SIGNER_PASSPHRASE', 'SIGNER_REMOTE_TOKEN'] as const;

export async function bootstrap(
  env: NodeJS.ProcessEnv = process.env,
  role: BootstrapRole = 'api',
): Promise<Bootstrap> {
  loadEnvFile();
  const source = role === 'api' ? omitSecrets(env) : env;
  const config = loadConfig(source, { role });
  if (role === 'api') {
    for (const key of SECRET_ENV) delete process.env[key];
  }
  const logger = createLogger(config);

  const db = createDatabase(config.database.url, config.database.ssl);
  const keyring = new Keyring(
    config.crypto.keyring,
    config.crypto.activeKid,
    config.crypto.legacyKid,
  );
  const cipher = new DataCipher(keyring);
  const repos = createRepositories(db.db, cipher);

  const hdWallet = HdWallet.fromAccountXpub(
    config.hd.xpub,
    config.hd.derivationPrefix,
    config.hd.accountIndex,
  );

  const signer = createProcessSigner(role, config, hdWallet, logger);

  const rpcUrls: Record<string, string> = {};
  const confirmUrls: Record<string, string> = {};
  for (const [chain, spec] of Object.entries(CHAINS)) {
    const url = env[spec.rpcEnvKey];
    if (url) rpcUrls[chain] = url;
    const confirm = env[`${spec.rpcEnvKey}_CONFIRM`];
    if (typeof confirm === 'string' && confirm.length > 0) confirmUrls[chain] = confirm;
  }
  const providerFactory = createProviderFactory(rpcUrls);
  const confirmProviderFactory =
    Object.keys(confirmUrls).length > 0 ? createProviderFactory(confirmUrls) : undefined;

  const gasSponsor =
    role === 'worker'
      ? GasSponsor.fromPrivateKey(
          config.gasSponsor.privateKey,
          config.gasSponsor.amountWei,
          config.gasSponsor.minBalanceWei,
          config.gasSponsor.address,
        )
      : GasSponsor.watchOnly(
          config.gasSponsor.address,
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
    cipher,
    ttlMinutes: config.links.ttlMinutes,
    publicBaseUrl: config.publicBaseUrl,
    settlement: config.settlement,
    webhook: config.webhook,
    requireHttpsWebhooks: config.server.isProduction,
    maxIndex: config.hd.maxIndex,
    monitor: {
      confirmationsRequired: config.chain.confirmationsRequired,
      tolerancePct: config.chain.tolerancePct,
      maxTopics: config.chain.maxTopics,
      blockRange: config.chain.blockRange,
      startBlock: config.chain.startBlock,
      blockTag: config.chain.blockTag,
      anchorInterval: config.chain.anchorInterval,
      backfillBlocks: config.chain.backfillBlocks,
    },
    confirmProviderFactory,
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

function omitSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of SECRET_ENV) delete copy[key];
  return copy;
}

/**
 * API: so endereco. Worker: keystore, signer remoto ou PSBT.
 * Exportado para o teste que garante que o papel `api` nao abre o keystore.
 */
export function createProcessSigner(
  role: BootstrapRole,
  config: AppConfig,
  hdWallet: HdWallet,
  logger: Logger,
): Signer {
  if (role === 'api') {
    const signer = new AddressOnlySigner(hdWallet, config.signer.mode);
    logger.info({ signer: signer.describe() }, 'signer da API sem chave privada');
    return signer;
  }
  return createSigningSigner(config, hdWallet, logger);
}

function createSigningSigner(config: AppConfig, hdWallet: HdWallet, logger: Logger): Signer {
  switch (config.signer.mode) {
    case 'local': {
      const passphrase = config.signer.passphrase;
      if (!passphrase) {
        throw new Error(
          'SIGNER_PASSPHRASE obrigatorio no modo local (senha do keystore cifrado)',
        );
      }
      const signer = LocalSigner.fromKeystoreFile(config.signer.keystorePath, passphrase);
      signer.verifyMatches(hdWallet);
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
