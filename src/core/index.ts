import { DataCipher, BlindIndex } from './crypto/cipher.js';
import { BlockchainMonitor, type MonitorOptions } from './chain/monitor.js';
import { ReorgDetector } from './chain/reorg-detector.js';
import { GasSponsor } from './chain/gas-sponsor.js';
import { Sweeper, type SweeperOptions } from './chain/sweeper.js';
import type { ProviderFactory } from './chain/provider.js';
import type { CustomerRepository } from './ports/index.js';
import type { Logger } from './logger.js';
import { CustomerService } from './services/customer-service.js';
import { LinkService } from './services/link-service.js';
import { LinkStateMachine } from './services/link-state-machine.js';
import type { HdWallet } from './hd/hd-wallet.js';
import type { Signer } from './signer/signer.js';
import type { MotorRepositories } from './ports/index.js';

/**
 * Ponto de entrada do motor.
 *
 * O core nao conhece HTTP, banco concreto, framework nem CLI: ele recebe os
 * ports e as dependencias via injecao. Qualquer aplicacao pode importar este
 * pacote e usar `createMotor` para ter cobranca + confirmacao on-chain +
 * varredura para a carteira fria.
 */

export type MotorOptions = {
  repos: MotorRepositories;
  hdWallet: HdWallet;
  signer: Signer;
  providerFactory: ProviderFactory;
  gasSponsor: GasSponsor;
  logger: Logger;
  dataKey: Buffer;
  indexKey: Buffer;
  ttlHours: number;
  monitor?: Partial<MonitorOptions>;
  sweeper?: Partial<SweeperOptions>;
};

export type Motor = {
  readonly customers: CustomerService;
  readonly links: LinkService;
  /** A4: unico caminho para mudar status de link. */
  readonly linkState: LinkStateMachine;
  readonly monitor: BlockchainMonitor;
  readonly sweeper: Sweeper;
  readonly repos: MotorRepositories;
  readonly signer: Signer;
  readonly hdWallet: HdWallet;
};

export function createMotor(options: MotorOptions): Motor {
  const cipher = new DataCipher(options.dataKey);
  const blindIndex = new BlindIndex(options.indexKey);
  const logger = options.logger;

  const customers = new CustomerService({
    repos: options.repos,
    cipher,
    blindIndex,
    logger,
  });

  const links = new LinkService({
    repos: options.repos,
    hdWallet: options.hdWallet,
    logger,
    ttlHours: options.ttlHours,
  });

  // A4: criado antes do monitor, que depende dele para mudar status.
  const linkState = new LinkStateMachine({ repos: options.repos, logger });

  // C2/C3: detector de reorg (ancoras esparsas + busca do ancestral comum).
  const reorgDetector = new ReorgDetector({
    cursors: options.repos.cursors,
    anchors: options.repos.anchors,
    logger,
    maxAnchors: options.monitor?.maxReorgAnchors ?? 64,
  });

  const monitor = new BlockchainMonitor({
    repos: options.repos,
    providerFactory: options.providerFactory,
    logger,
    linkState,
    reorgDetector,
    options: {
      confirmationsRequired: options.monitor?.confirmationsRequired ?? 10,
      tolerancePct: options.monitor?.tolerancePct ?? 1,
      maxTopics: options.monitor?.maxTopics ?? 200,
      blockRange: options.monitor?.blockRange ?? 2_000,
      startBlock: options.monitor?.startBlock ?? 0,
      blockTag: options.monitor?.blockTag ?? 'finalized',
      anchorInterval: options.monitor?.anchorInterval ?? 32,
      maxReorgAnchors: options.monitor?.maxReorgAnchors ?? 64,
    },
  });

  const sweeper = new Sweeper({
    repos: options.repos,
    providerFactory: options.providerFactory,
    signer: options.signer,
    gasSponsor: options.gasSponsor,
    linkState,
    logger,
    options: {
      gasSponsorAmountWei: options.sweeper?.gasSponsorAmountWei ?? 500_000_000_000_000_000n,
      gasSponsorMinBalanceWei: options.sweeper?.gasSponsorMinBalanceWei ?? 1_000_000_000_000_000_000n,
      batchSize: options.sweeper?.batchSize ?? 10,
      reconcileBatchSize: options.sweeper?.reconcileBatchSize ?? 25,
      tolerancePct: options.monitor?.tolerancePct ?? 1,
    },
  });

  return {
    customers,
    links,
    linkState,
    monitor,
    sweeper,
    repos: options.repos,
    signer: options.signer,
    hdWallet: options.hdWallet,
  };
}

export { CustomerService } from './services/customer-service.js';
export { LinkService } from './services/link-service.js';
export { LinkStateMachine } from './services/link-state-machine.js';
export {
  LINK_TRANSITIONS,
  canTransition,
  assertTransition,
  IllegalTransitionError,
} from './domain/link-state.js';
export { BlockchainMonitor } from './chain/monitor.js';
export { ReorgDetector } from './chain/reorg-detector.js';
export { qrCodeSvg, svgToDataUri, QrCodeError } from './qrcode.js';
export { collectAlerts, type Alerta, type AlertaNivel } from './alerts.js';
export { Sweeper } from './chain/sweeper.js';
export { GasSponsor } from './chain/gas-sponsor.js';
export { HdWallet } from './hd/hd-wallet.js';
export { LocalSigner } from './signer/local-signer.js';
export { RemoteSigner } from './signer/remote-signer.js';
export { PsbtSigner } from './signer/psbt-signer.js';
export { DataCipher, BlindIndex } from './crypto/cipher.js';
export { buildRampLink } from './ramp/link-builder.js';
export { CHAINS, chainSpec } from './chain/chains.js';
export { loadConfig } from './config.js';
export type * from './domain/types.js';
export type * from './ports/index.js';
export type { Logger } from './logger.js';
export type { CustomerRepository } from './ports/index.js';
