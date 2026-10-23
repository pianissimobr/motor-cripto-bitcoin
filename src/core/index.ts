import { BlockchainMonitor, type MonitorOptions } from './chain/monitor.js';
import { ReorgDetector } from './chain/reorg-detector.js';
import { GasSponsor } from './chain/gas-sponsor.js';
import { Sweeper, type SweeperOptions } from './chain/sweeper.js';
import type { ProviderFactory } from './chain/provider.js';
import type { Logger } from './logger.js';
import { ApiClientService } from './services/api-client-service.js';
import { LinkService } from './services/link-service.js';
import { LinkStateMachine } from './services/link-state-machine.js';
import { SettlementService } from './services/settlement-service.js';
import { WebhookService } from './services/webhook-service.js';
import type { HdWallet } from './hd/hd-wallet.js';
import type { Signer } from './signer/signer.js';
import type { MotorRepositories } from './ports/index.js';
import type { DataCipher } from './crypto/cipher.js';

/**
 * Ponto de entrada do motor.
 *
 * O core nao conhece HTTP, banco concreto ou framework: recebe os ports e
 * as dependencias via injecao. A API e o worker usam o mesmo `Motor`, mas
 * apenas o worker recebe signer/keystore.
 */

export type MotorOptions = {
  repos: MotorRepositories;
  hdWallet: HdWallet;
  signer: Signer;
  providerFactory: ProviderFactory;
  gasSponsor: GasSponsor;
  logger: Logger;
  cipher?: DataCipher;
  ttlMinutes: number;
  publicBaseUrl: string;
  settlement: { days: number };
  webhook: {
    timeoutMs: number;
    maxAttempts: number;
  };
  maxIndex?: number;
  monitor?: Partial<MonitorOptions>;
  sweeper?: Partial<SweeperOptions>;
  confirmProviderFactory?: ProviderFactory;
};

export type Motor = {
  readonly apiClients: ApiClientService;
  readonly links: LinkService;
  readonly linkState: LinkStateMachine;
  readonly settlement: SettlementService;
  readonly webhooks: WebhookService;
  readonly monitor: BlockchainMonitor;
  readonly sweeper: Sweeper;
  readonly repos: MotorRepositories;
  readonly signer: Signer;
  readonly hdWallet: HdWallet;
  readonly gasSponsor: GasSponsor;
  readonly providerFactory: ProviderFactory;
};

export function createMotor(options: MotorOptions): Motor {
  const logger = options.logger;
  const tolerancePct = options.monitor?.tolerancePct ?? 1;

  const apiClients = new ApiClientService({ repos: options.repos, logger });

  const webhooks = new WebhookService({
    repos: options.repos,
    logger,
    timeoutMs: options.webhook.timeoutMs,
    maxAttempts: options.webhook.maxAttempts,
  });

  const linkState = new LinkStateMachine({
    repos: options.repos,
    logger,
    onTransition: (link, to) => webhooks.enqueueForLink(link, to),
  });

  const links = new LinkService({
    repos: options.repos,
    hdWallet: options.hdWallet,
    linkState,
    logger,
    ttlMinutes: options.ttlMinutes,
    maxIndex: options.maxIndex ?? 100_000,
    publicBaseUrl: options.publicBaseUrl,
    settlement: options.settlement,
  });

  const settlement = new SettlementService({
    repos: options.repos,
    linkState,
    logger,
    tolerancePct,
  });

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
      tolerancePct,
      maxTopics: options.monitor?.maxTopics ?? 200,
      blockRange: options.monitor?.blockRange ?? 2_000,
      startBlock: options.monitor?.startBlock ?? 0,
      blockTag: options.monitor?.blockTag ?? 'finalized',
      anchorInterval: options.monitor?.anchorInterval ?? 32,
      maxReorgAnchors: options.monitor?.maxReorgAnchors ?? 64,
      backfillBlocks: options.monitor?.backfillBlocks ?? 100_000,
    },
    confirmProviderFactory: options.confirmProviderFactory,
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
      gasSponsorMinBalanceWei:
        options.sweeper?.gasSponsorMinBalanceWei ?? 100_000_000_000_000_000n,
      batchSize: options.sweeper?.batchSize ?? 10,
      reconcileBatchSize: options.sweeper?.reconcileBatchSize ?? 25,
      tolerancePct,
    },
  });

  return {
    apiClients,
    links,
    linkState,
    settlement,
    webhooks,
    monitor,
    sweeper,
    repos: options.repos,
    signer: options.signer,
    hdWallet: options.hdWallet,
    gasSponsor: options.gasSponsor,
    providerFactory: options.providerFactory,
  };
}

export { ApiClientService } from './services/api-client-service.js';
export { LinkService, hashCreateLinkRequest, hashPageToken } from './services/link-service.js';
export { LinkStateMachine } from './services/link-state-machine.js';
export { SettlementService } from './services/settlement-service.js';
export { WebhookService, buildWebhookPayload, signWebhook } from './services/webhook-service.js';
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
export { AddressOnlySigner } from './signer/address-signer.js';
export { LocalSigner } from './signer/local-signer.js';
export { RemoteSigner } from './signer/remote-signer.js';
export { PsbtSigner } from './signer/psbt-signer.js';
export { DataCipher, BlindIndex, Keyring } from './crypto/cipher.js';
export { buildRampLink } from './ramp/link-builder.js';
export { CHAINS, chainSpec } from './chain/chains.js';
export { loadConfig } from './config.js';
export type * from './domain/types.js';
export type * from './ports/index.js';
export type { Logger } from './logger.js';
