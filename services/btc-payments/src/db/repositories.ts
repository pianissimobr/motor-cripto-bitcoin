import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { assertTransition } from '../domain/status.js';
import type {
  AddressRevocation,
  ApiClient,
  ConversionLeg,
  ConversionOrder,
  FxQuote,
  HdAddress,
  LightningPayment,
  MerchantMember,
  MerchantWallet,
  OnchainPayment,
  OnchainSweep,
  PaidRail,
  PaymentIntent,
  CashOutCharge,
  PixCharge,
  SwapOrder,
  Payout,
  PayoutStatus,
  PaymentIntentStatus,
  PossessionChallenge,
  ServiceFlag,
  Session,
  SettlementChain,
  Subscription,
  SubscriptionCharge,
  SweepInput,
  User,
  WebhookEvent,
} from '../domain/types.js';
import type { Db } from './client.js';
import {
  storeKeys,
  addressRevocations,
  apiClients,
  apiNonces,
  auditEvents,
  conversionLegs,
  conversionOrders,
  emailVerificationTokens,
  hdAddresses,
  fxQuotes,
  hdWalletState,
  lightningPayments,
  merchantMembers,
  merchantWalletState,
  merchantWallets,
  onchainPayments,
  onchainSweeps,
  passwordResetTokens,
  paymentIntents,
  payouts,
  cashoutCharges,
  clientPixKeys,
  paymentRequests,
  pixCharges,
  possessionChallenges,
  providerEvents,
  reconciliationRuns,
  serviceFlags,
  sessions,
  subscriptionCharges,
  subscriptions,
  swapOrders,
  treasuryWallets,
  users,
  webhookEvents,
} from './schema.js';

export type HdWalletStateRecord = {
  nextReceiveIndex: number;
  gapLimit: number;
  xpubFingerprint: string;
};

export type CreateIntentWithAddressInput = {
  clientId: string;
  externalId: string;
  amountSats: bigint;
  description: string | null;
  metadata: Record<string, unknown> | null;
  expiresAt: Date;
  graceUntil: Date;
  maxIndex: number;
  currency?: 'BRL' | 'USD';
  amountFiat?: bigint;
  fxQuoteId?: string;
  initialStatus?: 'criando' | 'pendente';
  deriveAddress: (index: number) => {
    address: string;
    derivationPath: string;
  };
};

export type CreatedIntentWithAddress = {
  intent: PaymentIntent;
  address: HdAddress;
};

export type CreateIntentWithWalletAddressInput =
  CreateIntentWithAddressInput & {
    merchantWalletId: string;
  };

export type CreateIntentLightningOnlyInput = Omit<
  CreateIntentWithAddressInput,
  'deriveAddress'
> & {
  merchantWalletId?: string;
};

export type CreatedIntent = {
  intent: PaymentIntent;
  address: HdAddress | null;
};

export type SetLightningInvoiceInput = {
  intentId: string;
  paymentHash: string;
  invoice: string;
  lightningExpiresAt: Date;
  amountSats: bigint;
  lightningWalletId?: string | null;
};

export type MarkIntentPaidInput = {
  intentId: string;
  status: 'pago' | 'pago_tardio';
  paidRail: PaidRail;
  paidAmountSats: bigint;
  overpaidSats: bigint;
  paidAt: Date;
  lightningPaymentHash?: string;
  lightningRaw?: Record<string, unknown> | null;
};

export type CreateClientInput = {
  id: string;
  name: string;
  apiKeyPrefix: string;
  apiKeyHash: string;
  requestSecretEnc: string;
  webhookUrl: string;
  webhookSecretEnc: string;
  scopes?: import('../domain/types.js').ApiScope[];
  clientType?: import('../domain/types.js').ClientType;
  settlementAddress?: string | null;
};

export type UpsertOnchainPaymentInput = {
  intentId: string;
  addressId: string;
  txid: string;
  vout: number;
  amountSats: bigint;
  blockHeight: number | null;
  blockHash: string | null;
  confirmations: number;
  status: 'mempool' | 'confirmado';
};

export type SweepCandidate = {
  intentId: string;
  addressId: string;
  address: string;
  addressIndex: number;
  txid: string;
  vout: number;
  amountSats: bigint;
  confirmations: number;
  intentStatus: PaymentIntentStatus;
};

export type ClaimSweepInput = {
  intentId: string;
  addressId: string;
  amountSats: bigint;
  feeSats: bigint;
  coldWalletAddress: string;
  inputs: SweepInput[];
  status?: 'construindo' | 'manual';
  lastError?: string | null;
  createdAt?: Date;
  lastBroadcastAt?: Date | null;
};

export type UpdateSweepInput = {
  id: string;
  status?: OnchainSweep['status'];
  txid?: string | null;
  psbt?: string | null;
  rawTx?: string | null;
  feeSats?: bigint | null;
  inputs?: SweepInput[];
  confirmations?: number;
  lastCheckedAt?: Date | null;
  lastBroadcastAt?: Date | null;
  attempts?: number;
  lastError?: string | null;
  coldWalletAddress?: string | null;
};

export type ClientBalance = {
  clientId: string;
  name: string;
  paidRail: string;
  paidAmountSats: string;
};

export type StatusCounts = {
  intents: Record<string, number>;
  pixCharges: Record<string, number>;
  pixProviderEvents: Record<string, number>;
  pixSettlementLatencySeconds: number;
  webhooks: Record<string, number>;
  sweeps: Record<string, number>;
  pendingIntents: number;
  dueWebhooks: number;
  activeSweeps: number;
  clientBalances: ClientBalance[];
};

export type InsertWebhookEventInput = {
  clientId: string;
  intentId?: string | null;
  pixChargeId?: string | null;
  cashoutChargeId?: string | null;
  invoiceId?: string | null;
  /** Destino proprio (IPN da fatura); sem ele, o webhook da loja. */
  targetUrl?: string | null;
  /** Chave de loja que assina o evento; sem ela, o segredo do webhook da loja. */
  storeKeyId?: string | null;
  eventType: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
};

export type CreateConversionOrderInput = {
  merchantId: string;
  intentId: string;
  sourceAmountSats: bigint;
  provider: string;
  fxQuoteId?: string | null;
  targetAmountMinor?: bigint | null;
  providerOrderId?: string | null;
  inboundAddress?: string | null;
  memo?: string | null;
  quoteExpiresAt?: Date | null;
  providerPayload?: Record<string, unknown> | null;
};

export type UpdateConversionOrderInput = {
  id: string;
  status?: ConversionOrder['status'];
  targetAmountMinor?: bigint | null;
  providerOrderId?: string | null;
  inboundAddress?: string | null;
  memo?: string | null;
  quoteExpiresAt?: Date | null;
  providerPayload?: Record<string, unknown> | null;
  feeSats?: bigint | null;
  feeMinor?: bigint | null;
  txids?: string[];
  error?: string | null;
  attempts?: number;
};

export type UpsertConversionLegInput = {
  conversionId: string;
  leg: ConversionLeg['leg'];
  provider: string;
  status?: ConversionLeg['status'];
  txid?: string | null;
  providerRef?: string | null;
  amountIn?: bigint | null;
  amountOut?: bigint | null;
  feeMinor?: bigint | null;
};

export type CreatePayoutInput = {
  merchantId: string;
  walletId: string;
  amountMinor: bigint;
  idempotencyKey: string;
  conversionId?: string | null;
  pixChargeId?: string | null;
  destinationAddress?: string | null;
  feeMinor?: bigint | null;
  status?: PayoutStatus;
  approvedBy?: string | null;
  lastError?: string | null;
};

export type UpdatePayoutInput = {
  id: string;
  status?: PayoutStatus;
  txid?: string | null;
  feeMinor?: bigint | null;
  approvedBy?: string | null;
  lastError?: string | null;
  sentAt?: Date | null;
  confirmedAt?: Date | null;
};

export type InsertProviderEventInput = {
  provider: string;
  eventType: string;
  externalId: string;
  conversionId?: string | null;
  pixChargeId?: string | null;
  payload: Record<string, unknown>;
};

export type CreateCashOutChargeInput = {
  id?: string;
  clientId: string;
  externalId: string;
  providerExternalId: string;
  amountBrlCents: bigint;
  originAddress: string;
  asset?: 'USDC';
  network?: 'polygon';
  pixKeyMasked?: string | null;
  pixKeyType?: string | null;
  brCode?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type UpdateCashOutChargeInput = {
  id: string;
  status?: CashOutCharge['status'];
  providerCashoutId?: string | null;
  providerState?: CashOutCharge['providerState'];
  depositAddress?: string | null;
  depositTag?: string | null;
  amountAssetMinor?: bigint | null;
  feeTotalCents?: bigint | null;
  providerPath?: string | null;
  txHash?: string | null;
  pixE2e?: string | null;
  pixPaidAt?: Date | null;
  receiptUrl?: string | null;
  verifyUrl?: string | null;
  refundAddress?: string | null;
  providerPayload?: Record<string, unknown> | null;
  error?: string | null;
  attempts?: number;
  lastCheckedAt?: Date | null;
  expiresAt?: Date | null;
  version?: number;
};

export type CreateSwapOrderInput = {
  id?: string;
  clientId: string;
  externalId: string;
  providerExternalId?: string | null;
  amountFiatCents: bigint;
  currency: 'BRL' | 'USD';
  amountSats: bigint;
  sellAsset: string;
  buyAsset: string;
  network?: 'polygon';
  destinationAddress: string;
  sourceAddress?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type UpdateSwapOrderInput = {
  id: string;
  status?: SwapOrder['status'];
  providerOrderId?: string | null;
  providerState?: SwapOrder['providerState'];
  depositAddress?: string | null;
  depositChannelId?: string | null;
  expectedAssetMinor?: bigint | null;
  startBlock?: bigint | null;
  feeTotalBps?: number | null;
  expiresAt?: Date | null;
  providerPayload?: Record<string, unknown> | null;
  error?: string | null;
  attempts?: number;
  lastCheckedAt?: Date | null;
  version?: number;
};

export type ClientPixKey = {
  id: string;
  clientId: string;
  address: string;
  pixKey: string;
  pixKeyType: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random' | null;
  merchantName: string | null;
  city: string | null;
  status: 'ativo' | 'inativo';
  createdAt: Date;
  updatedAt: Date;
};

export type CreateClientPixKeyInput = {
  clientId: string;
  address: string;
  pixKey: string;
  pixKeyType?: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random' | null;
  merchantName?: string | null;
  city?: string | null;
};

export type PaymentRequest = {
  id: string;
  clientId: string;
  externalId: string;
  amountFiatCents: bigint;
  currency: 'BRL' | 'USD';
  rails: string[];
  status:
    | 'criando'
    | 'pendente'
    | 'pago'
    | 'parcial'
    | 'expirado'
    | 'cancelado'
    | 'falha';
  pixChargeId: string | null;
  swapOrderId: string | null;
  pixDirect: {
    br_code: string;
    key_masked: string;
    key_type: string | null;
    txid: string;
    amount: string;
  } | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CreatePaymentRequestInput = {
  id?: string;
  clientId: string;
  externalId: string;
  amountFiatCents: bigint;
  currency: 'BRL' | 'USD';
  rails: string[];
  expiresAt?: Date | null;
  metadata?: Record<string, unknown> | null;
};

export type UpdatePaymentRequestInput = {
  id: string;
  status?: PaymentRequest['status'];
  pixChargeId?: string | null;
  swapOrderId?: string | null;
  pixDirect?: PaymentRequest['pixDirect'];
  expiresAt?: Date | null;
  version?: number;
};

export type CreatePixChargeInput = {
  id?: string;
  clientId: string;
  externalId: string;
  providerExternalId: string;
  amountBrlCents: bigint;
  asset?: 'USDC';
  chain?: SettlementChain;
  destinationAddress?: string | null;
  payerTaxHash?: string | null;
  payerTaxLast4?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type UpdatePixChargeInput = {
  id: string;
  status?: PixCharge['status'];
  settlementStatus?: PixCharge['settlementStatus'];
  providerChargeId?: string | null;
  providerStatus?: PixCharge['providerStatus'];
  providerSettlementStatus?: PixCharge['providerSettlementStatus'];
  qrCopypaste?: string | null;
  qrImageUrl?: string | null;
  expiresAt?: Date | null;
  paidAt?: Date | null;
  settledAt?: Date | null;
  e2e?: string | null;
  payerName?: string | null;
  feeLuniumBps?: number | null;
  feeLuniumFixedCents?: bigint | null;
  feePartnerBps?: number | null;
  feeTotalCents?: bigint | null;
  netCents?: bigint | null;
  assetAmountMinor?: bigint | null;
  withdrawFee?: string | null;
  settlementTxHash?: string | null;
  settlementTxUrl?: string | null;
  providerPayload?: Record<string, unknown> | null;
  error?: string | null;
  attempts?: number;
  lastCheckedAt?: Date | null;
  payoutId?: string | null;
  version?: number;
};

export type Repositories = {
  ping: () => Promise<void>;

  // Clientes e nonces
  findClientByApiKeyHash: (hash: string) => Promise<ApiClient | null>;
  findClientById: (id: string) => Promise<ApiClient | null>;
  createClient: (input: CreateClientInput) => Promise<ApiClient>;
  listClients: () => Promise<ApiClient[]>;
  consumeNonce: (clientId: string, nonce: string, expiresAt: Date) => Promise<boolean>;
  cleanupExpiredNonces: () => Promise<number>;

  // Usuarios, sessoes e participacao em lojas (portal)
  findUserByEmail: (email: string) => Promise<User | null>;
  findUserById: (id: string) => Promise<User | null>;
  createUser: (input: {
    email: string;
    passwordHash: string;
    status: User['status'];
  }) => Promise<User>;
  updateUser: (
    id: string,
    input: {
      passwordHash?: string;
      status?: User['status'];
      emailVerifiedAt?: Date | null;
    },
  ) => Promise<User | null>;
  createMerchantMember: (input: {
    userId: string;
    merchantId: string;
    role: MerchantMember['role'];
  }) => Promise<MerchantMember>;
  /** E-mails dos membros ativos de uma loja (para avisos de seguranca). */
  listMerchantMemberEmails: (merchantId: string) => Promise<string[]>;
  findMerchantMember: (
    userId: string,
    merchantId: string,
  ) => Promise<MerchantMember | null>;
  listMerchantsForUser: (
    userId: string,
  ) => Promise<Array<{ member: MerchantMember; client: ApiClient }>>;

  // Sessoes
  createSession: (input: {
    userId: string;
    tokenHash: string;
    csrfTokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
  }) => Promise<Session>;
  findSessionByTokenHash: (tokenHash: string) => Promise<Session | null>;
  updateSessionSeen: (id: string, lastSeenAt: Date) => Promise<void>;
  revokeSession: (id: string) => Promise<void>;
  /** Revoga a sessao so se for do usuario; `false` quando nao e. */
  revokeSessionForUser: (id: string, userId: string) => Promise<boolean>;
  /** Revoga as sessoes abertas do usuario, menos `exceptId` quando dado. */
  revokeUserSessions: (userId: string, exceptId?: string) => Promise<number>;
  listActiveSessionsForUser: (userId: string, now: Date) => Promise<Session[]>;
  deleteExpiredSessions: (now: Date) => Promise<number>;

  // Tokens de verificacao de e-mail e reset de senha
  createEmailVerificationToken: (input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }) => Promise<{ id: string }>;
  findEmailVerificationTokenByHash: (
    tokenHash: string,
  ) => Promise<{ id: string; userId: string; expiresAt: Date; consumedAt: Date | null } | null>;
  consumeEmailVerificationToken: (id: string) => Promise<boolean>;
  createPasswordResetToken: (input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }) => Promise<{ id: string }>;
  findPasswordResetTokenByHash: (
    tokenHash: string,
  ) => Promise<{ id: string; userId: string; expiresAt: Date; consumedAt: Date | null } | null>;
  consumePasswordResetToken: (id: string) => Promise<boolean>;

  updateClientProfile: (
    id: string,
    input: { name?: string; webhookUrl?: string },
  ) => Promise<ApiClient | null>;

  rotateClientKey: (
    id: string,
    input: {
      apiKeyHash: string;
      apiKeyPrefix: string;
      requestSecretEnc: string;
      webhookSecretEnc?: string;
    },
  ) => Promise<ApiClient | null>;

  listIntentsForClient: (clientId: string, limit: number) => Promise<PaymentIntent[]>;
  deactivateMerchantWallet: (id: string) => Promise<void>;

  // Assinaturas (recorrente)
  createSubscription: (input: {
    merchantId: string;
    name: string;
    amountSats: bigint;
    description: string | null;
    interval: Subscription['interval'];
    status?: Subscription['status'];
    externalId?: string | null;
    metadata?: Record<string, unknown> | null;
    nextChargeAt: Date;
  }) => Promise<Subscription>;
  findSubscriptionById: (id: string) => Promise<Subscription | null>;
  findSubscriptionByIdForClient: (
    id: string,
    merchantId: string,
  ) => Promise<Subscription | null>;
  listSubscriptionsForClient: (
    merchantId: string,
    limit: number,
  ) => Promise<Subscription[]>;
  listDueSubscriptions: (now: Date, limit: number) => Promise<Subscription[]>;
  updateSubscription: (
    id: string,
    input: {
      name?: string;
      amountSats?: bigint;
      description?: string | null;
      interval?: Subscription['interval'];
      status?: Subscription['status'];
      nextChargeAt?: Date;
    },
  ) => Promise<Subscription | null>;
  createSubscriptionCharge: (input: {
    subscriptionId: string;
    intentId: string | null;
    periodStart: Date;
    periodEnd: Date;
    status?: SubscriptionCharge['status'];
  }) => Promise<SubscriptionCharge>;
  listSubscriptionCharges: (
    subscriptionId: string,
    limit: number,
  ) => Promise<SubscriptionCharge[]>;
  markSubscriptionCharge: (
    id: string,
    status: SubscriptionCharge['status'],
  ) => Promise<void>;
  listSubscriptionChargesByStatus: (
    status: SubscriptionCharge['status'],
    limit: number,
  ) => Promise<SubscriptionCharge[]>;
  findSubscriptionChargeByIntentId: (
    intentId: string,
  ) => Promise<SubscriptionCharge | null>;

  // HD wallet
  getHdWalletState: () => Promise<HdWalletStateRecord | null>;
  initHdWalletState: (input: {
    gapLimit: number;
    xpubFingerprint: string;
  }) => Promise<void>;
  allocateNextIndex: (maxIndex: number) => Promise<number>;
  insertHdAddress: (input: {
    index: number;
    address: string;
    derivationPath: string;
    intentId?: string | null;
  }) => Promise<HdAddress>;
  findFxQuoteById: (id: string) => Promise<FxQuote | null>;
  findMerchantWalletById: (id: string) => Promise<MerchantWallet | null>;
  findMerchantWalletByChainAddress: (
    chain: string,
    address: string,
  ) => Promise<MerchantWallet | null>;
  findActiveBtcDepositWalletForClient: (
    clientId: string,
  ) => Promise<MerchantWallet | null>;
  findDefaultBtcWallet: () => Promise<MerchantWallet | null>;
  findHdAddressById: (id: string) => Promise<HdAddress | null>;
  findHdAddressByIntentId: (intentId: string) => Promise<HdAddress | null>;
  markHdAddressUsed: (id: string) => Promise<void>;

  // Carteiras de liquidacao / treasury
  /** Uso do xpub do lojista: proximo indice e o maior indice que ja recebeu deposito. */
  getWalletGapUsage: (
    walletId: string,
  ) => Promise<{ nextIndex: number; lastUsedIndex: number } | null>;
  findActiveLightningWalletForClient: (clientId: string) => Promise<MerchantWallet | null>;
  findActiveUsdcSettlementWalletForClient: (
    clientId: string,
  ) => Promise<MerchantWallet | null>;
  findTreasuryWalletByKind: (kind: string) => Promise<{
    id: string;
    kind: string;
    chain: string;
    network: string;
    address: string;
    status: string;
  } | null>;
  listTreasuryWallets: () => Promise<Array<{
    id: string;
    kind: string;
    chain: string;
    network: string;
    address: string;
    status: string;
  }>>;

  // Conversao
  createConversionOrder: (
    input: CreateConversionOrderInput,
  ) => Promise<ConversionOrder>;
  findConversionOrderById: (id: string) => Promise<ConversionOrder | null>;
  findConversionOrderByIntentId: (
    intentId: string,
  ) => Promise<ConversionOrder | null>;
  updateConversionOrder: (
    input: UpdateConversionOrderInput,
  ) => Promise<ConversionOrder | null>;
  listIntentsAwaitingConversion: (limit: number) => Promise<PaymentIntent[]>;
  listConversionOrdersToQuote: (limit: number) => Promise<ConversionOrder[]>;
  listConversionOrdersToSend: (limit: number) => Promise<ConversionOrder[]>;
  listConversionOrdersToMonitor: (limit: number) => Promise<ConversionOrder[]>;
  listConvertedConversionsAwaitingPayout: (
    limit: number,
  ) => Promise<ConversionOrder[]>;
  listConversionOrders: (limit: number) => Promise<ConversionOrder[]>;
  listConversionOrdersForMerchant: (
    merchantId: string,
    limit: number,
  ) => Promise<ConversionOrder[]>;
  findConversionOrderByIdForMerchant: (
    id: string,
    merchantId: string,
  ) => Promise<ConversionOrder | null>;
  listConversionLegs: (conversionId: string) => Promise<ConversionLeg[]>;
  upsertConversionLeg: (
    input: UpsertConversionLegInput,
  ) => Promise<ConversionLeg>;
  insertProviderEvent: (input: InsertProviderEventInput) => Promise<boolean>;
  hasProviderEvent: (provider: string, externalId: string) => Promise<boolean>;
  findProviderEvent: (
    provider: string,
    externalId: string,
  ) => Promise<{ eventType: string; payload: Record<string, unknown> } | null>;
  listUnprocessedProviderEvents: (
    provider: string,
    limit: number,
  ) => Promise<Array<{ id: string; eventType: string; externalId: string; payload: Record<string, unknown> }>>;
  markProviderEventProcessed: (id: string) => Promise<void>;
  updateIntentSettlement: (input: {
    intentId: string;
    from: PaymentIntent['settlementStatus'][];
    to: PaymentIntent['settlementStatus'];
    conversionOrderId?: string | null;
    payoutId?: string | null;
  }) => Promise<PaymentIntent | null>;

  // PIX
  createPixCharge: (input: CreatePixChargeInput) => Promise<PixCharge>;
  findPixChargeById: (id: string) => Promise<PixCharge | null>;
  findPixChargeByIdForClient: (
    id: string,
    clientId: string,
  ) => Promise<PixCharge | null>;
  findPixChargeByClientAndExternalId: (
    clientId: string,
    externalId: string,
  ) => Promise<PixCharge | null>;
  findPixChargeByProviderChargeId: (
    provider: string,
    providerChargeId: string,
  ) => Promise<PixCharge | null>;
  updatePixCharge: (input: UpdatePixChargeInput) => Promise<PixCharge | null>;
  listPixChargesToReconcile: (limit: number) => Promise<PixCharge[]>;
  listPixChargesAwaitingPayout: (limit: number) => Promise<PixCharge[]>;
  listPixCharges: (limit: number) => Promise<PixCharge[]>;
  listPixChargesForMerchant: (
    merchantId: string,
    limit: number,
  ) => Promise<PixCharge[]>;

  // Cash-out (venda de cripto por Pix)
  createCashOutCharge: (input: CreateCashOutChargeInput) => Promise<CashOutCharge>;
  findCashOutChargeById: (id: string) => Promise<CashOutCharge | null>;
  findCashOutChargeByIdForClient: (
    id: string,
    clientId: string,
  ) => Promise<CashOutCharge | null>;
  findCashOutChargeByClientAndExternalId: (
    clientId: string,
    externalId: string,
  ) => Promise<CashOutCharge | null>;
  findCashOutChargeByProviderCashoutId: (
    provider: string,
    providerCashoutId: string,
  ) => Promise<CashOutCharge | null>;
  updateCashOutCharge: (input: UpdateCashOutChargeInput) => Promise<CashOutCharge | null>;
  /**
   * Reserva a unica reposicao de gas da ordem. Devolve `null` quando a ordem
   * nao esta aguardando deposito, ja tem `tx_hash` ou ja teve reposicao.
   */
  reserveCashOutGasTopUp: (
    id: string,
    clientId: string,
    at: Date,
  ) => Promise<CashOutCharge | null>;
  /** Grava o hash da reposicao feita. */
  finishCashOutGasTopUp: (id: string, txHash: string) => Promise<void>;
  /** Devolve a vaga quando o envio falhou ou nada precisou ser enviado. */
  releaseCashOutGasTopUp: (id: string) => Promise<void>;
  /** Reposicoes feitas (com hash) desde `since`, em todas as ordens. */
  countCashOutGasTopUpsSince: (since: Date) => Promise<number>;
  /**
   * `true` quando o cliente tem uma ordem aberta que ja recebeu gas e ainda
   * nao foi depositada: o gas dela ainda nao foi usado.
   */
  hasUnusedCashOutGasTopUp: (clientId: string) => Promise<boolean>;
  listCashOutChargesToReconcile: (limit: number) => Promise<CashOutCharge[]>;
  listCashOutChargesForOriginAddress: (
    originAddress: string,
    limit: number,
  ) => Promise<CashOutCharge[]>;

  // Chave Pix do proprio usuario (trilho "Pix direto")
  createClientPixKey: (input: CreateClientPixKeyInput) => Promise<ClientPixKey>;
  findClientPixKeyByClientId: (clientId: string) => Promise<ClientPixKey | null>;
  updateClientPixKey: (
    input: Partial<CreateClientPixKeyInput> & { clientId: string },
  ) => Promise<ClientPixKey | null>;

  // Pedido de pagamento com mais de um trilho
  createPaymentRequest: (input: CreatePaymentRequestInput) => Promise<PaymentRequest>;
  findPaymentRequestById: (id: string) => Promise<PaymentRequest | null>;
  findPaymentRequestByIdForClient: (
    id: string,
    clientId: string,
  ) => Promise<PaymentRequest | null>;
  findPaymentRequestByClientAndExternalId: (
    clientId: string,
    externalId: string,
  ) => Promise<PaymentRequest | null>;
  updatePaymentRequest: (input: UpdatePaymentRequestInput) => Promise<PaymentRequest | null>;

  // Swap (Bitcoin -> dolar digital, pela SwapKit)
  createSwapOrder: (input: CreateSwapOrderInput) => Promise<SwapOrder>;
  findSwapOrderById: (id: string) => Promise<SwapOrder | null>;
  findSwapOrderByIdForClient: (
    id: string,
    clientId: string,
  ) => Promise<SwapOrder | null>;
  findSwapOrderByClientAndExternalId: (
    clientId: string,
    externalId: string,
  ) => Promise<SwapOrder | null>;
  findSwapOrderByProviderOrderId: (
    provider: string,
    providerOrderId: string,
  ) => Promise<SwapOrder | null>;
  updateSwapOrder: (input: UpdateSwapOrderInput) => Promise<SwapOrder | null>;
  /** `true` quando a transferencia (tx + log) ja provou a entrega de algum pedido. */
  isSwapDeliveryClaimed: (txHash: string, logIndex: number) => Promise<boolean>;
  /**
   * Amarra a transferencia ao pedido. `false` quando outro pedido ja a usou
   * (indice unico) ou o pedido ja tem prova.
   */
  claimSwapDelivery: (id: string, txHash: string, logIndex: number) => Promise<boolean>;
  listSwapOrdersToReconcile: (limit: number) => Promise<SwapOrder[]>;
  /**
   * Pedido aberto com o mesmo valor em sats.
   *
   * O provedor deriva o endereco de deposito do valor (no FLASHNET), entao dois
   * pedidos com o mesmo valor cairiam no mesmo endereco e a atribuicao do
   * pagamento ficaria ambigua.
   */
  findOpenSwapOrderByAmountSats: (amountSats: bigint) => Promise<SwapOrder | null>;

  // Prova de posse (C12) e revogacao de endereco (C12.1)
  createPossessionChallenge: (input: {
    nonce: string;
    address: string;
    purpose: 'client_registration' | 'wallet_registration';
    message: string;
    expiresAt: Date;
  }) => Promise<PossessionChallenge>;
  consumePossessionChallenge: (
    nonce: string,
    now: Date,
  ) => Promise<PossessionChallenge | null>;
  deleteExpiredPossessionChallenges: (now: Date) => Promise<number>;
  findClientBySettlementAddress: (
    address: string,
  ) => Promise<ApiClient | null>;
  createAddressRevocation: (input: {
    address: string;
    merchantId: string | null;
  }) => Promise<AddressRevocation>;
  listAddressRevocations: (
    address: string,
  ) => Promise<AddressRevocation[]>;
  isAddressRevoked: (
    address: string,
    merchantId: string,
  ) => Promise<boolean>;

  // Flags do servico (F7)
  getServiceFlag: (key: string) => Promise<ServiceFlag | null>;
  setServiceFlag: (
    key: string,
    value: Record<string, unknown>,
  ) => Promise<ServiceFlag>;
  listServiceFlags: () => Promise<ServiceFlag[]>;

  // Extrato por endereco (C5)
  listPixChargesByDestinationAddress: (
    address: string,
    limit: number,
    before?: { createdAt: Date; id: string } | null,
  ) => Promise<PixCharge[]>;
  listCashOutChargesByOriginAddress: (
    address: string,
    limit: number,
    before?: { createdAt: Date; id: string } | null,
  ) => Promise<CashOutCharge[]>;

  // Payout
  createPayout: (input: CreatePayoutInput) => Promise<Payout>;
  findPayoutById: (id: string) => Promise<Payout | null>;
  findPayoutByConversionId: (conversionId: string) => Promise<Payout | null>;
  findPayoutByPixChargeId: (pixChargeId: string) => Promise<Payout | null>;
  updatePayout: (input: UpdatePayoutInput) => Promise<Payout | null>;
  claimPayoutForSending: (id: string) => Promise<Payout | null>;
  listPayoutsToSend: (limit: number) => Promise<Payout[]>;
  listPayoutsToMonitor: (limit: number) => Promise<Payout[]>;
  listPayouts: (limit: number) => Promise<Payout[]>;
  listPayoutsForMerchant: (
    merchantId: string,
    limit: number,
  ) => Promise<Payout[]>;
  findPayoutByIdForMerchant: (
    id: string,
    merchantId: string,
  ) => Promise<Payout | null>;
  getSettlementCounts: () => Promise<{
    conversions: Record<string, number>;
    payouts: Record<string, number>;
  }>;
  insertReconciliationRun: (job: string) => Promise<{ id: string }>;
  finishReconciliationRun: (input: {
    id: string;
    ok: boolean;
    details: Record<string, unknown>;
  }) => Promise<void>;
  listReconciliationRuns: (limit: number) => Promise<Array<{
    id: string;
    job: string;
    startedAt: Date;
    finishedAt: Date | null;
    ok: boolean | null;
    details: Record<string, unknown> | null;
  }>>;
  sumPayoutMinorSince: (merchantId: string, since: Date) => Promise<bigint>;

  // Intents
  createIntentWithAddress: (
    input: CreateIntentWithAddressInput,
  ) => Promise<CreatedIntentWithAddress>;
  createIntentLightningOnly: (
    input: CreateIntentLightningOnlyInput,
  ) => Promise<CreatedIntent>;
  createIntentWithWalletAddress: (
    input: CreateIntentWithWalletAddressInput,
  ) => Promise<CreatedIntentWithAddress>;
  findIntentById: (id: string) => Promise<PaymentIntent | null>;
  findIntentByIdForClient: (
    id: string,
    clientId: string,
  ) => Promise<PaymentIntent | null>;
  findIntentByClientAndExternalId: (
    clientId: string,
    externalId: string,
  ) => Promise<PaymentIntent | null>;
  findIntentByLightningPaymentHash: (
    paymentHash: string,
  ) => Promise<PaymentIntent | null>;
  listPendingLightningIntents: (limit: number) => Promise<PaymentIntent[]>;
  listPaidLightningIntentsForTreasury: (limit: number) => Promise<PaymentIntent[]>;
  listDueIntents: (now: Date, limit: number) => Promise<PaymentIntent[]>;
  listWatchableOnchainIntents: (now: Date, limit: number) => Promise<PaymentIntent[]>;
  setLightningInvoice: (
    input: SetLightningInvoiceInput,
  ) => Promise<PaymentIntent>;
  markCreationFailed: (intentId: string, addressId: string | null) => Promise<void>;
  markIntentPaid: (input: MarkIntentPaidInput) => Promise<PaymentIntent | null>;
  addOnchainToLightningPaidIntent: (
    intentId: string,
    onchainAmountSats: bigint,
  ) => Promise<PaymentIntent | null>;
  addLightningToOnchainPaidIntent: (input: {
    intentId: string;
    lightningSats: bigint;
    paymentHash: string;
    paidAt: Date;
    raw?: Record<string, unknown> | null;
  }) => Promise<PaymentIntent | null>;
  markIntentExpired: (intentId: string) => Promise<PaymentIntent | null>;
  markIntentPartial: (intentId: string) => Promise<PaymentIntent | null>;
  markIntentCanceled: (intentId: string) => Promise<PaymentIntent | null>;
  markIntentReorg: (intentId: string) => Promise<PaymentIntent | null>;
  revisePaidCustody: (input: {
    intentId: string;
    paidRail: PaidRail;
    paidAmountSats: bigint;
    overpaidSats: bigint;
  }) => Promise<PaymentIntent | null>;
  listRecoveryIntents: (now: Date, limit: number) => Promise<PaymentIntent[]>;
  touchIntent: (id: string) => Promise<void>;

  // On-chain payments
  upsertOnchainPayment: (
    input: UpsertOnchainPaymentInput,
  ) => Promise<OnchainPayment>;
  listOnchainPaymentsForIntent: (intentId: string) => Promise<OnchainPayment[]>;
  updateOnchainPaymentStatus: (input: {
    txid: string;
    vout: number;
    status: OnchainPayment['status'];
    confirmations: number;
    blockHeight: number | null;
    blockHash: string | null;
    /** Permite sair de `gasto` quando o tx de deposito sumiu. */
    forceFromGasto?: boolean;
  }) => Promise<void>;
  sumOnchainForIntent: (
    intentId: string,
    statuses?: Array<'mempool' | 'confirmado' | 'gasto'>,
  ) => Promise<bigint>;

  // Sweep
  listConfirmedOnchainPaymentsForSweep: (
    limit: number,
    opts: {
      confirmations: number;
      highValueSats: bigint;
      highValueConfirmations: number;
    },
  ) => Promise<SweepCandidate[]>;
  claimSweep: (input: ClaimSweepInput) => Promise<OnchainSweep | null>;
  findSweepById: (id: string) => Promise<OnchainSweep | null>;
  listSweepsToMonitor: (limit: number) => Promise<OnchainSweep[]>;
  updateSweep: (input: UpdateSweepInput) => Promise<OnchainSweep | null>;
  listSweeps: (limit: number) => Promise<OnchainSweep[]>;
  listSweepsForAddress: (addressId: string) => Promise<OnchainSweep[]>;
  markOnchainPaymentsGasto: (inputs: SweepInput[]) => Promise<void>;
  restoreOnchainPayments: (inputs: SweepInput[]) => Promise<void>;

  // Lightning payments
  findLightningPaymentByHash: (
    paymentHash: string,
  ) => Promise<LightningPayment | null>;
  noteLightningMismatch: (
    paymentHash: string,
    detail: Record<string, unknown>,
  ) => Promise<boolean>;

  // Webhooks
  insertWebhookEvent: (
    input: InsertWebhookEventInput,
  ) => Promise<WebhookEvent | null>;
  listDueWebhookEvents: (now: Date, limit: number) => Promise<WebhookEvent[]>;
  markWebhookDelivered: (id: string) => Promise<void>;
  markWebhookFailed: (input: {
    id: string;
    attempts: number;
    nextAttemptAt: Date;
    lastError: string;
    final: boolean;
  }) => Promise<void>;

  // Observabilidade / admin
  getStatusCounts: () => Promise<StatusCounts>;
  listWebhookEvents: (limit: number) => Promise<WebhookEvent[]>;
  /** Chave de loja (assinatura do IPN da fatura), mesmo revogada. */
  findStoreKeyById: (id: string) => Promise<{ id: string; ipnSecretEnc: string } | null>;
  replayWebhookEvent: (id: string) => Promise<WebhookEvent | null>;

  // Auditoria
  insertAuditEvent: (input: {
    actor: string;
    action: string;
    entity: string;
    entityId: string;
    ip?: string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
};

const HOUR_MS = 60 * 60 * 1000;
const ACTIVE_SWEEP_STATUSES = [
  'pendente',
  'construindo',
  'assinando',
  'transmitindo',
  'aguardando_confirmacao_rede',
  'manual',
] as const;

async function transitionIntent(
  database: Db,
  intentId: string,
  to: PaymentIntentStatus,
  from: readonly PaymentIntentStatus[],
  set: Record<string, unknown>,
): Promise<PaymentIntent | null> {
  return database.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, intentId))
      .for('update')
      .limit(1);
    const current = locked[0];
    if (!current || !from.includes(current.status)) return null;
    assertTransition(current.status, to);
    const rows = await tx
      .update(paymentIntents)
      .set(set)
      .where(eq(paymentIntents.id, intentId))
      .returning();
    return rows[0] ?? null;
  });
}

export function createRepositories(db: Db): Repositories {
  return {
    async ping() {
      await db.execute(sql`select 1`);
    },

    async findClientByApiKeyHash(hash) {
      const rows = await db
        .select()
        .from(apiClients)
        .where(eq(apiClients.apiKeyHash, hash))
        .limit(1);
      return rows[0] ?? null;
    },

    async findClientById(id) {
      const rows = await db
        .select()
        .from(apiClients)
        .where(eq(apiClients.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async createClient(input) {
      const rows = await db
        .insert(apiClients)
        .values({
          ...input,
          ...(input.scopes ? { scopes: input.scopes } : {}),
          ...(input.clientType ? { clientType: input.clientType } : {}),
          ...(input.settlementAddress
            ? { settlementAddress: input.settlementAddress.toLowerCase() }
            : {}),
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao criar cliente');
      return row;
    },

    async listClients() {
      return db.select().from(apiClients).orderBy(asc(apiClients.createdAt));
    },

    async consumeNonce(clientId, nonce, expiresAt) {
      const rows = await db
        .insert(apiNonces)
        .values({ clientId, nonce, expiresAt })
        .onConflictDoNothing()
        .returning({ nonce: apiNonces.nonce });
      return rows.length > 0;
    },

    async cleanupExpiredNonces() {
      const rows = await db
        .delete(apiNonces)
        .where(lte(apiNonces.expiresAt, new Date()))
        .returning({ nonce: apiNonces.nonce });
      return rows.length;
    },

    async findUserByEmail(email) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return rows[0] ?? null;
    },

    async findUserById(id) {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async createUser(input) {
      const rows = await db
        .insert(users)
        .values({
          email: input.email,
          passwordHash: input.passwordHash,
          status: input.status,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao criar usuario');
      return row;
    },

    async updateUser(id, input) {
      const rows = await db
        .update(users)
        .set({
          ...(input.passwordHash !== undefined
            ? { passwordHash: input.passwordHash }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.emailVerifiedAt !== undefined
            ? { emailVerifiedAt: input.emailVerifiedAt }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async createMerchantMember(input) {
      const rows = await db
        .insert(merchantMembers)
        .values({
          userId: input.userId,
          merchantId: input.merchantId,
          role: input.role,
        })
        .onConflictDoNothing()
        .returning();
      const row = rows[0];
      if (row) return row;
      const existing = await db
        .select()
        .from(merchantMembers)
        .where(
          and(
            eq(merchantMembers.userId, input.userId),
            eq(merchantMembers.merchantId, input.merchantId),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error('falha ao criar participacao na loja');
      return found;
    },

    async findMerchantMember(userId, merchantId) {
      const rows = await db
        .select()
        .from(merchantMembers)
        .where(
          and(
            eq(merchantMembers.userId, userId),
            eq(merchantMembers.merchantId, merchantId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async listMerchantsForUser(userId) {
      const rows = await db
        .select()
        .from(merchantMembers)
        .innerJoin(apiClients, eq(merchantMembers.merchantId, apiClients.id))
        .where(eq(merchantMembers.userId, userId))
        .orderBy(asc(merchantMembers.createdAt));
      return rows.map((row) => ({
        member: row.merchant_members,
        client: row.api_clients,
      }));
    },

    async createSession(input) {
      const rows = await db
        .insert(sessions)
        .values({
          userId: input.userId,
          tokenHash: input.tokenHash,
          csrfTokenHash: input.csrfTokenHash,
          expiresAt: input.expiresAt,
          userAgent: input.userAgent ?? null,
          ip: input.ip ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao criar sessao');
      return row;
    },

    async findSessionByTokenHash(tokenHash) {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateSessionSeen(id, lastSeenAt) {
      await db
        .update(sessions)
        .set({ lastSeenAt })
        .where(eq(sessions.id, id));
    },

    async revokeSession(id) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, id));
    },

    async revokeSessionForUser(id, userId) {
      const rows = await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, id), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      return rows.length > 0;
    },

    async revokeUserSessions(userId, exceptId) {
      const rows = await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            ...(exceptId ? [ne(sessions.id, exceptId)] : []),
          ),
        )
        .returning({ id: sessions.id });
      return rows.length;
    },

    async listActiveSessionsForUser(userId, now) {
      return db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
        .orderBy(desc(sessions.createdAt))
        .limit(50);
    },

    async deleteExpiredSessions(now) {
      const rows = await db
        .delete(sessions)
        .where(lte(sessions.expiresAt, now))
        .returning({ id: sessions.id });
      return rows.length;
    },

    async createEmailVerificationToken(input) {
      const rows = await db
        .insert(emailVerificationTokens)
        .values({
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        })
        .returning({ id: emailVerificationTokens.id });
      const row = rows[0];
      if (!row) throw new Error('falha ao criar token de verificacao');
      return row;
    },

    async findEmailVerificationTokenByHash(tokenHash) {
      const rows = await db
        .select({
          id: emailVerificationTokens.id,
          userId: emailVerificationTokens.userId,
          expiresAt: emailVerificationTokens.expiresAt,
          consumedAt: emailVerificationTokens.consumedAt,
        })
        .from(emailVerificationTokens)
        .where(eq(emailVerificationTokens.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async consumeEmailVerificationToken(id) {
      const rows = await db
        .update(emailVerificationTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(emailVerificationTokens.id, id),
            isNull(emailVerificationTokens.consumedAt),
          ),
        )
        .returning({ id: emailVerificationTokens.id });
      return rows.length > 0;
    },

    async createPasswordResetToken(input) {
      const rows = await db
        .insert(passwordResetTokens)
        .values({
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        })
        .returning({ id: passwordResetTokens.id });
      const row = rows[0];
      if (!row) throw new Error('falha ao criar token de reset');
      return row;
    },

    async findPasswordResetTokenByHash(tokenHash) {
      const rows = await db
        .select({
          id: passwordResetTokens.id,
          userId: passwordResetTokens.userId,
          expiresAt: passwordResetTokens.expiresAt,
          consumedAt: passwordResetTokens.consumedAt,
        })
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async consumePasswordResetToken(id) {
      const rows = await db
        .update(passwordResetTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.id, id),
            isNull(passwordResetTokens.consumedAt),
          ),
        )
        .returning({ id: passwordResetTokens.id });
      return rows.length > 0;
    },

    async updateClientProfile(id, input) {
      const rows = await db
        .update(apiClients)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.webhookUrl !== undefined
            ? { webhookUrl: input.webhookUrl }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(apiClients.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async rotateClientKey(id, input) {
      const rows = await db
        .update(apiClients)
        .set({
          apiKeyHash: input.apiKeyHash,
          apiKeyPrefix: input.apiKeyPrefix,
          requestSecretEnc: input.requestSecretEnc,
          ...(input.webhookSecretEnc ? { webhookSecretEnc: input.webhookSecretEnc } : {}),
          updatedAt: new Date(),
        })
        .where(eq(apiClients.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async listIntentsForClient(clientId, limit) {
      return db
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.clientId, clientId))
        .orderBy(desc(paymentIntents.createdAt))
        .limit(limit);
    },

    async deactivateMerchantWallet(id) {
      await db
        .update(merchantWallets)
        .set({ status: 'inativo', updatedAt: new Date() })
        .where(eq(merchantWallets.id, id));
    },

    async createSubscription(input) {
      const rows = await db
        .insert(subscriptions)
        .values({
          merchantId: input.merchantId,
          name: input.name,
          amountSats: input.amountSats,
          description: input.description,
          interval: input.interval,
          status: input.status ?? 'ativa',
          externalId: input.externalId ?? null,
          metadata: input.metadata ?? null,
          nextChargeAt: input.nextChargeAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao criar assinatura');
      return row;
    },

    async findSubscriptionById(id) {
      const rows = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findSubscriptionByIdForClient(id, merchantId) {
      const rows = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.id, id),
            eq(subscriptions.merchantId, merchantId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async listSubscriptionsForClient(merchantId, limit) {
      return db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.merchantId, merchantId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(limit);
    },

    async listDueSubscriptions(now, limit) {
      return db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.status, 'ativa'),
            lte(subscriptions.nextChargeAt, now),
          ),
        )
        .orderBy(asc(subscriptions.nextChargeAt))
        .limit(limit);
    },

    async updateSubscription(id, input) {
      const rows = await db
        .update(subscriptions)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.amountSats !== undefined ? { amountSats: input.amountSats } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.interval !== undefined ? { interval: input.interval } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.nextChargeAt !== undefined
            ? { nextChargeAt: input.nextChargeAt }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async createSubscriptionCharge(input) {
      const rows = await db
        .insert(subscriptionCharges)
        .values({
          subscriptionId: input.subscriptionId,
          intentId: input.intentId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          status: input.status ?? 'criada',
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao criar ciclo da assinatura');
      return row;
    },

    async listSubscriptionCharges(subscriptionId, limit) {
      return db
        .select()
        .from(subscriptionCharges)
        .where(eq(subscriptionCharges.subscriptionId, subscriptionId))
        .orderBy(desc(subscriptionCharges.createdAt))
        .limit(limit);
    },

    async markSubscriptionCharge(id, status) {
      await db
        .update(subscriptionCharges)
        .set({ status })
        .where(eq(subscriptionCharges.id, id));
    },

    async listSubscriptionChargesByStatus(status, limit) {
      return db
        .select()
        .from(subscriptionCharges)
        .where(eq(subscriptionCharges.status, status))
        .orderBy(asc(subscriptionCharges.createdAt))
        .limit(limit);
    },

    async findSubscriptionChargeByIntentId(intentId) {
      const rows = await db
        .select()
        .from(subscriptionCharges)
        .where(eq(subscriptionCharges.intentId, intentId))
        .limit(1);
      return rows[0] ?? null;
    },

    async getHdWalletState() {
      const rows = await db.select().from(hdWalletState).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        nextReceiveIndex: row.nextReceiveIndex,
        gapLimit: row.gapLimit,
        xpubFingerprint: row.xpubFingerprint,
      };
    },

    async initHdWalletState(input) {
      await db
        .insert(hdWalletState)
        .values({
          id: 1,
          nextReceiveIndex: 0,
          gapLimit: input.gapLimit,
          xpubFingerprint: input.xpubFingerprint,
        })
        .onConflictDoNothing({ target: hdWalletState.id });
    },

    async allocateNextIndex(maxIndex) {
      const result = await db.execute<{ index: number }>(sql`
        UPDATE hd_wallet_state
        SET next_receive_index = next_receive_index + 1,
            updated_at = now()
        WHERE id = 1
          AND next_receive_index < ${maxIndex}
        RETURNING next_receive_index - 1 AS index
      `);
      const row = result[0];
      if (!row) {
        throw new Error(
          'limite de indices HD atingido ou hd_wallet_state nao inicializado',
        );
      }
      const index = Number(row.index);
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`indice HD invalido retornado pelo banco: ${String(row.index)}`);
      }
      return index;
    },

    async insertHdAddress(input) {
      const rows = await db
        .insert(hdAddresses)
        .values({
          index: input.index,
          address: input.address,
          derivationPath: input.derivationPath,
          intentId: input.intentId ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao inserir endereco HD');
      return row;
    },

    async findHdAddressById(id) {
      const rows = await db
        .select()
        .from(hdAddresses)
        .where(eq(hdAddresses.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findHdAddressByIntentId(intentId) {
      const rows = await db
        .select()
        .from(hdAddresses)
        .where(eq(hdAddresses.intentId, intentId))
        .limit(1);
      return rows[0] ?? null;
    },

    async markHdAddressUsed(id) {
      await db
        .update(hdAddresses)
        .set({ status: 'usada', usedAt: new Date() })
        .where(eq(hdAddresses.id, id));
    },

    async findFxQuoteById(id) {
      const rows = await db
        .select()
        .from(fxQuotes)
        .where(eq(fxQuotes.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findMerchantWalletById(id) {
      const rows = await db
        .select()
        .from(merchantWallets)
        .where(eq(merchantWallets.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findMerchantWalletByChainAddress(chain, address) {
      const rows = await db
        .select()
        .from(merchantWallets)
        .where(
          and(
            eq(merchantWallets.chain, chain),
            eq(merchantWallets.address, address.toLowerCase()),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findActiveBtcDepositWalletForClient(clientId) {
      const rows = await db
        .select()
        .from(merchantWallets)
        .where(
          and(
            eq(merchantWallets.merchantId, clientId),
            eq(merchantWallets.kind, 'btc_deposit'),
            eq(merchantWallets.status, 'ativo'),
          ),
        )
        .orderBy(asc(merchantWallets.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async findDefaultBtcWallet() {
      const rows = await db
        .select()
        .from(merchantWallets)
        .where(
          and(
            isNull(merchantWallets.merchantId),
            eq(merchantWallets.kind, 'btc_deposit'),
            eq(merchantWallets.status, 'ativo'),
          ),
        )
        .orderBy(asc(merchantWallets.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async createIntentWithWalletAddress(input) {
      return db.transaction(async (tx) => {
        const result = await tx.execute<{ index: number }>(sql`
          UPDATE merchant_wallet_state
          SET next_receive_index = next_receive_index + 1,
              updated_at = now()
          WHERE wallet_id = ${input.merchantWalletId}
            AND next_receive_index < ${input.maxIndex}
          RETURNING next_receive_index - 1 AS index
        `);
        const indexRow = result[0];
        if (!indexRow) {
          throw new Error(
            'limite de indices HD atingido ou carteira nao inicializada',
          );
        }
        const index = Number(indexRow.index);
        const derived = input.deriveAddress(index);

        const addressRows = await tx
          .insert(hdAddresses)
          .values({
            index,
            address: derived.address,
            derivationPath: derived.derivationPath,
            merchantWalletId: input.merchantWalletId,
            intentId: null,
          })
          .returning();
        const address = addressRows[0];
        if (!address) throw new Error('falha ao inserir endereco HD');

        const intentRows = await tx
          .insert(paymentIntents)
          .values({
            clientId: input.clientId,
            externalId: input.externalId,
            amountSats: input.amountSats,
            description: input.description,
            status: input.initialStatus ?? 'criando',
            expiresAt: input.expiresAt,
            graceUntil: input.graceUntil,
            onchainAddressId: address.id,
            merchantWalletId: input.merchantWalletId,
            ...(input.currency ? { currency: input.currency } : {}),
            ...(input.amountFiat !== undefined
              ? { amountFiat: input.amountFiat }
              : {}),
            ...(input.fxQuoteId ? { fxQuoteId: input.fxQuoteId } : {}),
            metadata: input.metadata,
          })
          .returning();
        const intent = intentRows[0];
        if (!intent) throw new Error('falha ao inserir intent');

        const linkedRows = await tx
          .update(hdAddresses)
          .set({ intentId: intent.id })
          .where(eq(hdAddresses.id, address.id))
          .returning();
        const linkedAddress = linkedRows[0];
        if (!linkedAddress) throw new Error('falha ao vincular endereco a intent');

        return { intent, address: linkedAddress };
      });
    },

    async createIntentWithAddress(input) {
      return db.transaction(async (tx) => {
        const result = await tx.execute<{ index: number }>(sql`
          UPDATE hd_wallet_state
          SET next_receive_index = next_receive_index + 1,
              updated_at = now()
          WHERE id = 1
            AND next_receive_index < ${input.maxIndex}
          RETURNING next_receive_index - 1 AS index
        `);
        const indexRow = result[0];
        if (!indexRow) {
          throw new Error(
            'limite de indices HD atingido ou hd_wallet_state nao inicializado',
          );
        }
        const index = Number(indexRow.index);
        const derived = input.deriveAddress(index);

        const addressRows = await tx
          .insert(hdAddresses)
          .values({
            index,
            address: derived.address,
            derivationPath: derived.derivationPath,
            intentId: null,
          })
          .returning();
        const address = addressRows[0];
        if (!address) throw new Error('falha ao inserir endereco HD');

        const intentRows = await tx
          .insert(paymentIntents)
          .values({
            clientId: input.clientId,
            externalId: input.externalId,
            amountSats: input.amountSats,
            description: input.description,
            status: input.initialStatus ?? 'criando',
            expiresAt: input.expiresAt,
            graceUntil: input.graceUntil,
            onchainAddressId: address.id,
            ...(input.currency ? { currency: input.currency } : {}),
            ...(input.amountFiat !== undefined
              ? { amountFiat: input.amountFiat }
              : {}),
            ...(input.fxQuoteId ? { fxQuoteId: input.fxQuoteId } : {}),
            metadata: input.metadata,
          })
          .returning();
        const intent = intentRows[0];
        if (!intent) throw new Error('falha ao inserir intent');

        const linkedRows = await tx
          .update(hdAddresses)
          .set({ intentId: intent.id })
          .where(eq(hdAddresses.id, address.id))
          .returning();
        const linkedAddress = linkedRows[0];
        if (!linkedAddress) throw new Error('falha ao vincular endereco a intent');

        return { intent, address: linkedAddress };
      });
    },

    async createIntentLightningOnly(input) {
      const intentRows = await db
        .insert(paymentIntents)
        .values({
          clientId: input.clientId,
          externalId: input.externalId,
          amountSats: input.amountSats,
          description: input.description,
          status: 'criando',
          expiresAt: input.expiresAt,
          graceUntil: input.graceUntil,
          onchainAddressId: null,
          ...(input.merchantWalletId
            ? { merchantWalletId: input.merchantWalletId }
            : {}),
          ...(input.currency ? { currency: input.currency } : {}),
          ...(input.amountFiat !== undefined
            ? { amountFiat: input.amountFiat }
            : {}),
          ...(input.fxQuoteId ? { fxQuoteId: input.fxQuoteId } : {}),
          metadata: input.metadata,
        })
        .returning();
      const intent = intentRows[0];
      if (!intent) throw new Error('falha ao inserir intent');
      return { intent, address: null };
    },

    async findIntentById(id) {
      const rows = await db
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findIntentByIdForClient(id, clientId) {
      const rows = await db
        .select()
        .from(paymentIntents)
        .where(and(eq(paymentIntents.id, id), eq(paymentIntents.clientId, clientId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async findIntentByClientAndExternalId(clientId, externalId) {
      const rows = await db
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.clientId, clientId),
            eq(paymentIntents.externalId, externalId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findIntentByLightningPaymentHash(paymentHash) {
      const rows = await db
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.lightningPaymentHash, paymentHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async listPendingLightningIntents(limit) {
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.status, 'pendente'),
            isNotNull(paymentIntents.lightningPaymentHash),
          ),
        )
        .orderBy(asc(paymentIntents.createdAt))
        .limit(limit);
    },

    async listPaidLightningIntentsForTreasury(limit) {
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            inArray(paymentIntents.status, ['pago', 'pago_tardio']),
            inArray(paymentIntents.paidRail, ['lightning', 'both']),
            isNotNull(paymentIntents.lightningPaymentHash),
          ),
        )
        .orderBy(asc(paymentIntents.paidAt))
        .limit(limit);
    },

    async listDueIntents(now, limit) {
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.status, 'pendente'),
            lte(paymentIntents.expiresAt, now),
          ),
        )
        .orderBy(asc(paymentIntents.expiresAt))
        .limit(limit);
    },

    async listWatchableOnchainIntents(now, limit) {
      const paidCutoff = new Date(now.getTime() - 24 * HOUR_MS);
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            isNotNull(paymentIntents.onchainAddressId),
            or(
              eq(paymentIntents.status, 'pendente'),
              eq(paymentIntents.status, 'reorg'),
              and(
                inArray(paymentIntents.status, ['pago', 'pago_tardio']),
                gt(paymentIntents.paidAt, paidCutoff),
              ),
              and(
                inArray(paymentIntents.status, ['expirado', 'parcial']),
                gt(paymentIntents.graceUntil, now),
              ),
            ),
          ),
        )
        .orderBy(asc(paymentIntents.createdAt))
        .limit(limit);
    },

    async setLightningInvoice(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(paymentIntents)
          .set({
            lightningPaymentHash: input.paymentHash,
            lightningInvoice: input.invoice,
            lightningExpiresAt: input.lightningExpiresAt,
            lightningWalletId: input.lightningWalletId ?? null,
            status: 'pendente',
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(paymentIntents.id, input.intentId),
              eq(paymentIntents.status, 'criando'),
            ),
          )
          .returning();
        const intent = rows[0];
        if (!intent) throw new Error('intent nao esta no estado criando');

        await tx.insert(lightningPayments).values({
          intentId: intent.id,
          paymentHash: input.paymentHash,
          invoice: input.invoice,
          amountSats: input.amountSats,
          status: 'pendente',
        });
        return intent;
      });
    },

    async markCreationFailed(intentId, addressId) {
      await db.transaction(async (tx) => {
        await tx
          .update(paymentIntents)
          .set({
            status: 'falha_criacao',
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(paymentIntents.id, intentId),
              eq(paymentIntents.status, 'criando'),
            ),
          );
        await tx
          .update(hdAddresses)
          .set({ status: 'abandonada' })
          .where(addressId ? eq(hdAddresses.id, addressId) : sql`false`);
      });
    },

    async markIntentPaid(input) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, input.intentId))
          .for('update')
          .limit(1);
        const current = locked[0];
        const from: PaymentIntentStatus[] = [
          'pendente',
          'expirado',
          'parcial',
          'reorg',
        ];
        if (!current || !from.includes(current.status)) return null;
        assertTransition(current.status, input.status);
        const rows = await tx
          .update(paymentIntents)
          .set({
            status: input.status,
            paidRail: input.paidRail,
            paidAmountSats: input.paidAmountSats,
            overpaidSats: input.overpaidSats,
            paidAt: input.paidAt,
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, input.intentId))
          .returning();
        const updated = rows[0];
        if (!updated) return null;
        if (input.lightningPaymentHash) {
          await tx
            .update(lightningPayments)
            .set({
              status: 'pago',
              amountSats: input.paidAmountSats,
              paidAt: input.paidAt,
              raw: input.lightningRaw ?? null,
              updatedAt: new Date(),
            })
            .where(eq(lightningPayments.paymentHash, input.lightningPaymentHash));
        }
        return updated;
      });
    },

    async addOnchainToLightningPaidIntent(intentId, onchainAmountSats) {
      const rows = await db
        .update(paymentIntents)
        .set({
          paidRail: 'both',
          paidAmountSats: sql`coalesce(${paymentIntents.paidAmountSats}, 0) + ${onchainAmountSats}`,
          overpaidSats: sql`greatest(0, coalesce(${paymentIntents.paidAmountSats}, 0) + ${onchainAmountSats} - ${paymentIntents.amountSats})`,
          version: sql`${paymentIntents.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentIntents.id, intentId),
            inArray(paymentIntents.status, ['pago', 'pago_tardio']),
            eq(paymentIntents.paidRail, 'lightning'),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async addLightningToOnchainPaidIntent(input) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, input.intentId))
          .for('update')
          .limit(1);
        const current = locked[0];
        if (
          !current ||
          (current.status !== 'pago' && current.status !== 'pago_tardio') ||
          current.paidRail !== 'onchain'
        ) {
          return null;
        }
        assertTransition(current.status, current.status);
        const rows = await tx
          .update(paymentIntents)
          .set({
            paidRail: 'both',
            paidAmountSats: sql`coalesce(${paymentIntents.paidAmountSats}, 0) + ${input.lightningSats}`,
            overpaidSats: sql`greatest(0, coalesce(${paymentIntents.paidAmountSats}, 0) + ${input.lightningSats} - ${paymentIntents.amountSats})`,
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, input.intentId))
          .returning();
        const updated = rows[0];
        if (!updated) return null;
        await tx
          .update(lightningPayments)
          .set({
            status: 'pago',
            amountSats: input.lightningSats,
            paidAt: input.paidAt,
            raw: input.raw ?? null,
            updatedAt: new Date(),
          })
          .where(eq(lightningPayments.paymentHash, input.paymentHash));
        return updated;
      });
    },

    async markIntentExpired(intentId) {
      return transitionIntent(db, intentId, 'expirado', ['pendente'], {
        status: 'expirado',
        version: sql`${paymentIntents.version} + 1`,
        updatedAt: new Date(),
      });
    },

    async markIntentPartial(intentId) {
      return transitionIntent(db, intentId, 'parcial', ['pendente'], {
        status: 'parcial',
        version: sql`${paymentIntents.version} + 1`,
        updatedAt: new Date(),
      });
    },

    async markIntentCanceled(intentId) {
      return transitionIntent(db, intentId, 'cancelado', ['pendente'], {
        status: 'cancelado',
        version: sql`${paymentIntents.version} + 1`,
        updatedAt: new Date(),
      });
    },

    async markIntentReorg(intentId) {
      return transitionIntent(db, intentId, 'reorg', ['pago', 'pago_tardio'], {
        status: 'reorg',
        version: sql`${paymentIntents.version} + 1`,
        updatedAt: new Date(),
      });
    },

    async revisePaidCustody(input) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, input.intentId))
          .for('update')
          .limit(1);
        const current = locked[0];
        if (!current || (current.status !== 'pago' && current.status !== 'pago_tardio')) {
          return null;
        }
        assertTransition(current.status, current.status);
        const rows = await tx
          .update(paymentIntents)
          .set({
            paidRail: input.paidRail,
            paidAmountSats: input.paidAmountSats,
            overpaidSats: input.overpaidSats,
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, input.intentId))
          .returning();
        return rows[0] ?? null;
      });
    },

    async listRecoveryIntents(now, limit) {
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            isNotNull(paymentIntents.onchainAddressId),
            or(
              eq(paymentIntents.status, 'cancelado'),
              and(
                inArray(paymentIntents.status, ['expirado', 'parcial']),
                lte(paymentIntents.graceUntil, now),
              ),
            ),
          ),
        )
        .orderBy(asc(paymentIntents.updatedAt))
        .limit(limit);
    },

    async touchIntent(id) {
      await db
        .update(paymentIntents)
        .set({ updatedAt: new Date() })
        .where(eq(paymentIntents.id, id));
    },

    async upsertOnchainPayment(input) {
      const now = new Date();
      const rows = await db
        .insert(onchainPayments)
        .values({
          intentId: input.intentId,
          addressId: input.addressId,
          txid: input.txid,
          vout: input.vout,
          amountSats: input.amountSats,
          blockHeight: input.blockHeight,
          blockHash: input.blockHash,
          confirmations: input.confirmations,
          status: input.status,
          ...(input.status === 'confirmado' ? { confirmedAt: now } : {}),
        })
        .onConflictDoUpdate({
          target: [onchainPayments.txid, onchainPayments.vout],
          set: {
            blockHeight: input.blockHeight,
            blockHash: input.blockHash,
            confirmations: input.confirmations,
            // Nao reabre um UTXO marcado como gasto por um sweep enquanto o
            // sweep estiver em andamento. Se o sweep falhar, o operador/retry
            // decide o proximo passo.
            status: sql`case when ${onchainPayments.status} = 'gasto' then 'gasto' else excluded.status end`,
            updatedAt: now,
            ...(input.status === 'confirmado' ? { confirmedAt: now } : {}),
          },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao gravar pagamento on-chain');
      return row;
    },

    async listOnchainPaymentsForIntent(intentId) {
      return db
        .select()
        .from(onchainPayments)
        .where(eq(onchainPayments.intentId, intentId));
    },

    async updateOnchainPaymentStatus(input) {
      const filters = [
        eq(onchainPayments.txid, input.txid),
        eq(onchainPayments.vout, input.vout),
      ];
      if (!input.forceFromGasto && input.status !== 'gasto') {
        filters.push(ne(onchainPayments.status, 'gasto'));
      }
      await db
        .update(onchainPayments)
        .set({
          status: input.status,
          confirmations: input.confirmations,
          blockHeight: input.blockHeight,
          blockHash: input.blockHash,
          updatedAt: new Date(),
        })
        .where(and(...filters));
    },

    async sumOnchainForIntent(intentId, statuses = ['mempool', 'confirmado']) {
      const rows = await db
        .select({ amountSats: onchainPayments.amountSats })
        .from(onchainPayments)
        .where(
          and(
            eq(onchainPayments.intentId, intentId),
            inArray(onchainPayments.status, statuses),
          ),
        );
      return rows.reduce((total, row) => total + row.amountSats, 0n);
    },

    async listConfirmedOnchainPaymentsForSweep(limit, opts) {
      const rows = await db.execute<{
        intent_id: string;
        address_id: string;
        address: string;
        address_index: number;
        txid: string;
        vout: number;
        amount_sats: string;
        confirmations: number;
        intent_status: PaymentIntentStatus;
      }>(sql`
        select op.intent_id, op.address_id, ha.address,
               ha."index" as address_index, op.txid, op.vout,
               op.amount_sats, op.confirmations,
               pi.status as intent_status
        from onchain_payments op
        join hd_addresses ha on ha.id = op.address_id
        join payment_intents pi on pi.id = op.intent_id
        where op.status = 'confirmado'
          and pi.status in ('pago','pago_tardio','parcial','expirado','cancelado')
          and op.confirmations >= case
            when pi.amount_sats >= ${opts.highValueSats.toString()}::bigint
              then ${opts.highValueConfirmations}::int
            else ${opts.confirmations}::int
          end
          and not exists (
            select 1 from onchain_sweeps s
            where s.address_id = op.address_id
              and s.status in ('pendente','construindo','assinando','transmitindo','aguardando_confirmacao_rede','manual')
          )
        order by op.address_id, op.first_seen_at
        limit ${limit}
      `);
      return rows.map((row) => ({
        intentId: row.intent_id,
        addressId: row.address_id,
        address: row.address,
        addressIndex: Number(row.address_index),
        txid: row.txid,
        vout: Number(row.vout),
        amountSats: BigInt(String(row.amount_sats)),
        confirmations: Number(row.confirmations),
        intentStatus: row.intent_status,
      }));
    },

    async claimSweep(input) {
      return db.transaction(async (tx) => {
        const locked = await tx.execute<{ id: string }>(sql`
          select id from hd_addresses where id = ${input.addressId} for update
        `);
        if (locked.length === 0) return null;

        const active = await tx
          .select()
          .from(onchainSweeps)
          .where(
            and(
              eq(onchainSweeps.addressId, input.addressId),
              inArray(onchainSweeps.status, [...ACTIVE_SWEEP_STATUSES]),
            ),
          )
          .limit(1);
        if (active.length > 0) return null;

        const rows = await tx
          .insert(onchainSweeps)
          .values({
            intentId: input.intentId,
            addressId: input.addressId,
            amountSats: input.amountSats,
            feeSats: input.feeSats,
            coldWalletAddress: input.coldWalletAddress,
            inputs: input.inputs,
            status: input.status ?? 'construindo',
            lastError: input.lastError ?? null,
            ...(input.createdAt ? { createdAt: input.createdAt } : {}),
            ...(input.lastBroadcastAt !== undefined
              ? { lastBroadcastAt: input.lastBroadcastAt }
              : {}),
          })
          .returning();
        return rows[0] ?? null;
      });
    },

    async findSweepById(id) {
      const rows = await db
        .select()
        .from(onchainSweeps)
        .where(eq(onchainSweeps.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async listSweepsToMonitor(limit) {
      return db
        .select()
        .from(onchainSweeps)
        .where(
          inArray(onchainSweeps.status, [
            'transmitindo',
            'aguardando_confirmacao_rede',
          ]),
        )
        .orderBy(asc(onchainSweeps.updatedAt))
        .limit(limit);
    },

    async updateSweep(input) {
      const rows = await db
        .update(onchainSweeps)
        .set({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.txid !== undefined ? { txid: input.txid } : {}),
          ...(input.psbt !== undefined ? { psbt: input.psbt } : {}),
          ...(input.rawTx !== undefined ? { rawTx: input.rawTx } : {}),
          ...(input.feeSats !== undefined ? { feeSats: input.feeSats } : {}),
          ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
          ...(input.confirmations !== undefined
            ? { confirmations: input.confirmations }
            : {}),
          ...(input.lastCheckedAt !== undefined
            ? { lastCheckedAt: input.lastCheckedAt }
            : {}),
          ...(input.lastBroadcastAt !== undefined
            ? { lastBroadcastAt: input.lastBroadcastAt }
            : {}),
          ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
          ...(input.lastError !== undefined
            ? { lastError: input.lastError }
            : {}),
          ...(input.coldWalletAddress !== undefined
            ? { coldWalletAddress: input.coldWalletAddress }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(onchainSweeps.id, input.id))
        .returning();
      return rows[0] ?? null;
    },

    async listSweeps(limit) {
      return db
        .select()
        .from(onchainSweeps)
        .orderBy(asc(onchainSweeps.createdAt))
        .limit(limit);
    },

    async listSweepsForAddress(addressId) {
      return db
        .select()
        .from(onchainSweeps)
        .where(eq(onchainSweeps.addressId, addressId));
    },

    async markOnchainPaymentsGasto(inputs) {
      for (const input of inputs) {
        await db
          .update(onchainPayments)
          .set({ status: 'gasto', updatedAt: new Date() })
          .where(
            and(
              eq(onchainPayments.txid, input.txid),
              eq(onchainPayments.vout, input.vout),
            ),
          );
      }
    },

    async restoreOnchainPayments(inputs) {
      for (const input of inputs) {
        await db
          .update(onchainPayments)
          .set({ status: 'confirmado', updatedAt: new Date() })
          .where(
            and(
              eq(onchainPayments.txid, input.txid),
              eq(onchainPayments.vout, input.vout),
              eq(onchainPayments.status, 'gasto'),
            ),
          );
      }
    },

    async findLightningPaymentByHash(paymentHash) {
      const rows = await db
        .select()
        .from(lightningPayments)
        .where(eq(lightningPayments.paymentHash, paymentHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async noteLightningMismatch(paymentHash, detail) {
      const rows = await db
        .update(lightningPayments)
        .set({
          raw: { kind: 'amount_mismatch', ...detail },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(lightningPayments.paymentHash, paymentHash),
            sql`coalesce(${lightningPayments.raw}->>'kind', '') = ''`,
          ),
        )
        .returning({ id: lightningPayments.id });
      return rows.length > 0;
    },

    async insertWebhookEvent(input) {
      const rows = await db
        .insert(webhookEvents)
        .values({
          clientId: input.clientId,
          intentId: input.intentId ?? null,
          pixChargeId: input.pixChargeId ?? null,
          cashoutChargeId: input.cashoutChargeId ?? null,
          invoiceId: input.invoiceId ?? null,
          targetUrl: input.targetUrl ?? null,
          storeKeyId: input.storeKeyId ?? null,
          eventType: input.eventType,
          dedupeKey: input.dedupeKey,
          payload: input.payload,
        })
        .onConflictDoNothing({ target: webhookEvents.dedupeKey })
        .returning();
      return rows[0] ?? null;
    },

    async listDueWebhookEvents(now, limit) {
      return db
        .select()
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.status, 'pendente'),
            lte(webhookEvents.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(webhookEvents.nextAttemptAt))
        .limit(limit);
    },

    async markWebhookDelivered(id) {
      await db
        .update(webhookEvents)
        .set({
          status: 'entregue',
          deliveredAt: new Date(),
          attempts: sql`${webhookEvents.attempts} + 1`,
        })
        .where(eq(webhookEvents.id, id));
    },

    async markWebhookFailed(input) {
      await db
        .update(webhookEvents)
        .set({
          attempts: input.attempts,
          nextAttemptAt: input.nextAttemptAt,
          lastError: input.lastError,
          status: input.final ? 'falhou' : 'pendente',
        })
        .where(eq(webhookEvents.id, input.id));
    },

    async findStoreKeyById(id) {
      const rows = await db
        .select({ id: storeKeys.id, ipnSecretEnc: storeKeys.ipnSecretEnc })
        .from(storeKeys)
        .where(eq(storeKeys.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async listWebhookEvents(limit) {
      return db
        .select()
        .from(webhookEvents)
        .orderBy(asc(webhookEvents.createdAt))
        .limit(limit);
    },

    async replayWebhookEvent(id) {
      const rows = await db
        .update(webhookEvents)
        .set({
          status: 'pendente',
          nextAttemptAt: new Date(),
          attempts: 0,
          lastError: null,
          deliveredAt: null,
        })
        .where(eq(webhookEvents.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async listMerchantMemberEmails(merchantId) {
      const rows = await db
        .select({ email: users.email })
        .from(merchantMembers)
        .innerJoin(users, eq(users.id, merchantMembers.userId))
        .where(eq(merchantMembers.merchantId, merchantId));
      return rows.map((row) => row.email);
    },

    async getWalletGapUsage(walletId) {
      const rows = await db.execute<{ next_index: number; last_used: number }>(sql`
        select s.next_receive_index::int as next_index,
               coalesce(max(a.index) filter (where a.status in ('usada', 'sweepada')), -1)::int as last_used
          from merchant_wallet_state s
          left join hd_addresses a on a.merchant_wallet_id = s.wallet_id
         where s.wallet_id = ${walletId}
         group by s.next_receive_index
      `);
      const row = rows[0];
      return row ? { nextIndex: row.next_index, lastUsedIndex: row.last_used } : null;
    },

    async findActiveLightningWalletForClient(clientId) {
      const rows = await db
        .select()
        .from(merchantWallets)
        .where(
          and(
            eq(merchantWallets.merchantId, clientId),
            eq(merchantWallets.kind, 'lightning_lnbits'),
            eq(merchantWallets.status, 'ativo'),
          ),
        )
        .orderBy(desc(merchantWallets.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async findActiveUsdcSettlementWalletForClient(clientId) {
      const rows = await db
        .select()
        .from(merchantWallets)
        .where(
          and(
            eq(merchantWallets.merchantId, clientId),
            eq(merchantWallets.kind, 'usdc_settlement'),
            eq(merchantWallets.status, 'ativo'),
            // A carteira de liquidacao da LOJA. As carteiras de cliente
            // (F4) nunca podem ser o destino de uma cobranca da loja.
            eq(merchantWallets.purpose, 'loja'),
          ),
        )
        // A padrao escolhida no painel; sem padrao, a mais antiga.
        .orderBy(desc(merchantWallets.isDefault), asc(merchantWallets.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async findTreasuryWalletByKind(kind) {
      const rows = await db
        .select({
          id: treasuryWallets.id,
          kind: treasuryWallets.kind,
          chain: treasuryWallets.chain,
          network: treasuryWallets.network,
          address: treasuryWallets.address,
          status: treasuryWallets.status,
        })
        .from(treasuryWallets)
        .where(
          and(eq(treasuryWallets.kind, kind as never), eq(treasuryWallets.status, 'ativo')),
        )
        .orderBy(asc(treasuryWallets.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async createConversionOrder(input) {
      const rows = await db
        .insert(conversionOrders)
        .values({
          merchantId: input.merchantId,
          intentId: input.intentId,
          sourceAmountSats: input.sourceAmountSats,
          provider: input.provider,
          fxQuoteId: input.fxQuoteId ?? null,
          targetAmountMinor: input.targetAmountMinor ?? null,
          providerOrderId: input.providerOrderId ?? null,
          inboundAddress: input.inboundAddress ?? null,
          memo: input.memo ?? null,
          quoteExpiresAt: input.quoteExpiresAt ?? null,
          providerPayload: input.providerPayload ?? null,
        })
        .onConflictDoNothing({ target: conversionOrders.intentId })
        .returning();
      const created = rows[0];
      if (created) return created;
      const existing = await db
        .select()
        .from(conversionOrders)
        .where(eq(conversionOrders.intentId, input.intentId))
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error('falha ao criar ordem de conversao');
      return found;
    },

    async findConversionOrderById(id) {
      const rows = await db
        .select()
        .from(conversionOrders)
        .where(eq(conversionOrders.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findConversionOrderByIntentId(intentId) {
      const rows = await db
        .select()
        .from(conversionOrders)
        .where(eq(conversionOrders.intentId, intentId))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateConversionOrder(input) {
      const rows = await db
        .update(conversionOrders)
        .set({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.targetAmountMinor !== undefined
            ? { targetAmountMinor: input.targetAmountMinor }
            : {}),
          ...(input.providerOrderId !== undefined
            ? { providerOrderId: input.providerOrderId }
            : {}),
          ...(input.inboundAddress !== undefined
            ? { inboundAddress: input.inboundAddress }
            : {}),
          ...(input.memo !== undefined ? { memo: input.memo } : {}),
          ...(input.quoteExpiresAt !== undefined
            ? { quoteExpiresAt: input.quoteExpiresAt }
            : {}),
          ...(input.providerPayload !== undefined
            ? { providerPayload: input.providerPayload }
            : {}),
          ...(input.feeSats !== undefined ? { feeSats: input.feeSats } : {}),
          ...(input.feeMinor !== undefined ? { feeMinor: input.feeMinor } : {}),
          ...(input.txids !== undefined ? { txids: input.txids } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
          updatedAt: new Date(),
        })
        .where(eq(conversionOrders.id, input.id))
        .returning();
      return rows[0] ?? null;
    },

    async listIntentsAwaitingConversion(limit) {
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            inArray(paymentIntents.status, ['pago', 'pago_tardio']),
            inArray(paymentIntents.settlementStatus, [
              'nao_iniciado',
              'aguardando_confirmacao',
              'pronto_para_conversao',
            ]),
            isNull(paymentIntents.conversionOrderId),
          ),
        )
        .orderBy(asc(paymentIntents.paidAt))
        .limit(limit);
    },

    async listConversionOrdersToQuote(limit) {
      return db
        .select()
        .from(conversionOrders)
        .where(eq(conversionOrders.status, 'criada'))
        .orderBy(asc(conversionOrders.createdAt))
        .limit(limit);
    },

    async listConversionOrdersToSend(limit) {
      return db
        .select()
        .from(conversionOrders)
        .where(eq(conversionOrders.status, 'enviando_btc'))
        .orderBy(asc(conversionOrders.updatedAt))
        .limit(limit);
    },

    async listConversionOrdersToMonitor(limit) {
      return db
        .select()
        .from(conversionOrders)
        .where(
          inArray(conversionOrders.status, ['aguardando_swap', 'recebendo_usdc']),
        )
        .orderBy(asc(conversionOrders.updatedAt))
        .limit(limit);
    },

    async listConversionOrders(limit) {
      return db
        .select()
        .from(conversionOrders)
        .orderBy(asc(conversionOrders.createdAt))
        .limit(limit);
    },

    async listConversionOrdersForMerchant(merchantId, limit) {
      return db
        .select()
        .from(conversionOrders)
        .where(eq(conversionOrders.merchantId, merchantId))
        .orderBy(asc(conversionOrders.createdAt))
        .limit(limit);
    },

    async findConversionOrderByIdForMerchant(id, merchantId) {
      const rows = await db
        .select()
        .from(conversionOrders)
        .where(
          and(
            eq(conversionOrders.id, id),
            eq(conversionOrders.merchantId, merchantId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async listConversionLegs(conversionId) {
      return db
        .select()
        .from(conversionLegs)
        .where(eq(conversionLegs.conversionId, conversionId))
        .orderBy(asc(conversionLegs.createdAt));
    },

    async listConvertedConversionsAwaitingPayout(limit) {
      return db
        .select()
        .from(conversionOrders)
        .where(eq(conversionOrders.status, 'convertida'))
        .orderBy(asc(conversionOrders.updatedAt))
        .limit(limit);
    },

    async upsertConversionLeg(input) {
      const rows = await db
        .insert(conversionLegs)
        .values({
          conversionId: input.conversionId,
          leg: input.leg,
          provider: input.provider,
          status: input.status ?? 'pendente',
          txid: input.txid ?? null,
          providerRef: input.providerRef ?? null,
          amountIn: input.amountIn ?? null,
          amountOut: input.amountOut ?? null,
          feeMinor: input.feeMinor ?? null,
        })
        .onConflictDoUpdate({
          target: [conversionLegs.conversionId, conversionLegs.leg],
          set: {
            provider: input.provider,
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.txid !== undefined ? { txid: input.txid } : {}),
            ...(input.providerRef !== undefined
              ? { providerRef: input.providerRef }
              : {}),
            ...(input.amountIn !== undefined ? { amountIn: input.amountIn } : {}),
            ...(input.amountOut !== undefined
              ? { amountOut: input.amountOut }
              : {}),
            ...(input.feeMinor !== undefined ? { feeMinor: input.feeMinor } : {}),
            updatedAt: new Date(),
          },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao gravar perna da conversao');
      return row;
    },

    async createPixCharge(input) {
      const rows = await db
        .insert(pixCharges)
        .values({
          ...(input.id ? { id: input.id } : {}),
          clientId: input.clientId,
          externalId: input.externalId,
          provider: 'lunium',
          providerExternalId: input.providerExternalId,
          amountBrlCents: input.amountBrlCents,
          asset: input.asset ?? 'USDC',
          chain: input.chain ?? 'base',
          destinationAddress: input.destinationAddress ?? null,
          payerTaxHash: input.payerTaxHash ?? null,
          payerTaxLast4: input.payerTaxLast4 ?? null,
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing({
          target: [pixCharges.clientId, pixCharges.externalId],
        })
        .returning();
      const created = rows[0];
      if (created) return created;
      const existing = await db
        .select()
        .from(pixCharges)
        .where(
          and(
            eq(pixCharges.clientId, input.clientId),
            eq(pixCharges.externalId, input.externalId),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error('falha ao criar cobranca PIX');
      return found;
    },

    async createCashOutCharge(input) {
      const rows = await db
        .insert(cashoutCharges)
        .values({
          ...(input.id ? { id: input.id } : {}),
          clientId: input.clientId,
          externalId: input.externalId,
          provider: 'lunium',
          providerExternalId: input.providerExternalId,
          amountBrlCents: input.amountBrlCents,
          originAddress: input.originAddress,
          asset: input.asset ?? 'USDC',
          network: input.network ?? 'polygon',
          pixKeyMasked: input.pixKeyMasked ?? null,
          pixKeyType: input.pixKeyType ?? null,
          brCode: input.brCode ?? null,
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing({
          target: [cashoutCharges.clientId, cashoutCharges.externalId],
        })
        .returning();
      const created = rows[0];
      if (created) return created;
      const existing = await db
        .select()
        .from(cashoutCharges)
        .where(
          and(
            eq(cashoutCharges.clientId, input.clientId),
            eq(cashoutCharges.externalId, input.externalId),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error('falha ao criar cash-out');
      return found;
    },

    async createClientPixKey(input: CreateClientPixKeyInput) {
      const rows = await db
        .insert(clientPixKeys)
        .values({
          clientId: input.clientId,
          address: input.address,
          pixKey: input.pixKey,
          pixKeyType: input.pixKeyType ?? null,
          merchantName: input.merchantName ?? null,
          city: input.city ?? null,
        })
        .onConflictDoNothing({ target: [clientPixKeys.clientId] })
        .returning();
      const created = rows[0];
      if (created) return created;
      // Ja existe uma chave para este cliente: a nova substitui a antiga.
      const updated = await db
        .update(clientPixKeys)
        .set({
          address: input.address,
          pixKey: input.pixKey,
          pixKeyType: input.pixKeyType ?? null,
          merchantName: input.merchantName ?? null,
          city: input.city ?? null,
          status: 'ativo',
          updatedAt: new Date(),
        })
        .where(eq(clientPixKeys.clientId, input.clientId))
        .returning();
      const found = updated[0];
      if (!found) throw new Error('falha ao salvar a chave Pix');
      return found;
    },

    async findClientPixKeyByClientId(clientId) {
      const rows = await db
        .select()
        .from(clientPixKeys)
        .where(eq(clientPixKeys.clientId, clientId))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateClientPixKey(input) {
      const rows = await db
        .update(clientPixKeys)
        .set({
          ...(input.address !== undefined ? { address: input.address } : {}),
          ...(input.pixKey !== undefined ? { pixKey: input.pixKey } : {}),
          ...(input.pixKeyType !== undefined ? { pixKeyType: input.pixKeyType } : {}),
          ...(input.merchantName !== undefined
            ? { merchantName: input.merchantName }
            : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          updatedAt: new Date(),
        })
        .where(eq(clientPixKeys.clientId, input.clientId))
        .returning();
      return rows[0] ?? null;
    },

    async createPaymentRequest(input: CreatePaymentRequestInput) {
      const rows = await db
        .insert(paymentRequests)
        .values({
          ...(input.id ? { id: input.id } : {}),
          clientId: input.clientId,
          externalId: input.externalId,
          amountFiatCents: input.amountFiatCents,
          currency: input.currency,
          rails: input.rails,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing({
          target: [paymentRequests.clientId, paymentRequests.externalId],
        })
        .returning();
      const created = rows[0];
      if (created) return created;
      const existing = await db
        .select()
        .from(paymentRequests)
        .where(
          and(
            eq(paymentRequests.clientId, input.clientId),
            eq(paymentRequests.externalId, input.externalId),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error('falha ao criar o pedido de pagamento');
      return found;
    },

    async findPaymentRequestById(id) {
      const rows = await db
        .select()
        .from(paymentRequests)
        .where(eq(paymentRequests.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findPaymentRequestByIdForClient(id, clientId) {
      const rows = await db
        .select()
        .from(paymentRequests)
        .where(
          and(
            eq(paymentRequests.id, id),
            eq(paymentRequests.clientId, clientId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findPaymentRequestByClientAndExternalId(clientId, externalId) {
      const rows = await db
        .select()
        .from(paymentRequests)
        .where(
          and(
            eq(paymentRequests.clientId, clientId),
            eq(paymentRequests.externalId, externalId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async updatePaymentRequest(input: UpdatePaymentRequestInput) {
      const rows = await db
        .update(paymentRequests)
        .set({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.pixChargeId !== undefined
            ? { pixChargeId: input.pixChargeId }
            : {}),
          ...(input.swapOrderId !== undefined
            ? { swapOrderId: input.swapOrderId }
            : {}),
          ...(input.pixDirect !== undefined ? { pixDirect: input.pixDirect } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          ...(input.version !== undefined ? { version: input.version } : {}),
          updatedAt: new Date(),
        })
        .where(eq(paymentRequests.id, input.id))
        .returning();
      return rows[0] ?? null;
    },

    async createSwapOrder(input: CreateSwapOrderInput) {
      const rows = await db
        .insert(swapOrders)
        .values({
          ...(input.id ? { id: input.id } : {}),
          clientId: input.clientId,
          externalId: input.externalId,
          provider: 'swapkit',
          providerOrderId: input.providerExternalId ?? null,
          amountFiatCents: input.amountFiatCents,
          currency: input.currency,
          amountSats: input.amountSats,
          sellAsset: input.sellAsset,
          buyAsset: input.buyAsset,
          network: input.network ?? 'polygon',
          destinationAddress: input.destinationAddress,
          sourceAddress: input.sourceAddress ?? null,
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing({
          target: [swapOrders.clientId, swapOrders.externalId],
        })
        .returning();
      const created = rows[0];
      if (created) return created;
      const existing = await db
        .select()
        .from(swapOrders)
        .where(
          and(
            eq(swapOrders.clientId, input.clientId),
            eq(swapOrders.externalId, input.externalId),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error('falha ao criar pedido de swap');
      return found;
    },

    async findSwapOrderById(id) {
      const rows = await db
        .select()
        .from(swapOrders)
        .where(eq(swapOrders.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findSwapOrderByIdForClient(id, clientId) {
      const rows = await db
        .select()
        .from(swapOrders)
        .where(and(eq(swapOrders.id, id), eq(swapOrders.clientId, clientId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async findSwapOrderByClientAndExternalId(clientId, externalId) {
      const rows = await db
        .select()
        .from(swapOrders)
        .where(
          and(
            eq(swapOrders.clientId, clientId),
            eq(swapOrders.externalId, externalId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findSwapOrderByProviderOrderId(provider, providerOrderId) {
      const rows = await db
        .select()
        .from(swapOrders)
        .where(
          and(
            eq(swapOrders.provider, provider as 'swapkit'),
            eq(swapOrders.providerOrderId, providerOrderId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async updateSwapOrder(input: UpdateSwapOrderInput) {
      const rows = await db
        .update(swapOrders)
        .set({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.providerOrderId !== undefined
            ? { providerOrderId: input.providerOrderId }
            : {}),
          ...(input.providerState !== undefined
            ? { providerState: input.providerState }
            : {}),
          ...(input.depositAddress !== undefined
            ? { depositAddress: input.depositAddress }
            : {}),
          ...(input.depositChannelId !== undefined
            ? { depositChannelId: input.depositChannelId }
            : {}),
          ...(input.startBlock !== undefined ? { startBlock: input.startBlock } : {}),
          ...(input.expectedAssetMinor !== undefined
            ? { expectedAssetMinor: input.expectedAssetMinor }
            : {}),
          ...(input.feeTotalBps !== undefined
            ? { feeTotalBps: input.feeTotalBps }
            : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          ...(input.providerPayload !== undefined
            ? { providerPayload: input.providerPayload }
            : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
          ...(input.lastCheckedAt !== undefined
            ? { lastCheckedAt: input.lastCheckedAt }
            : {}),
          ...(input.version !== undefined ? { version: input.version } : {}),
          updatedAt: new Date(),
        })
        .where(eq(swapOrders.id, input.id))
        .returning();
      return rows[0] ?? null;
    },

    async isSwapDeliveryClaimed(txHash, logIndex) {
      const rows = await db
        .select({ id: swapOrders.id })
        .from(swapOrders)
        .where(
          and(
            eq(swapOrders.deliveryTxHash, txHash.toLowerCase()),
            eq(swapOrders.deliveryLogIndex, logIndex),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async claimSwapDelivery(id, txHash, logIndex) {
      try {
        const rows = await db
          .update(swapOrders)
          .set({
            deliveryTxHash: txHash.toLowerCase(),
            deliveryLogIndex: logIndex,
            updatedAt: new Date(),
          })
          .where(and(eq(swapOrders.id, id), isNull(swapOrders.deliveryTxHash)))
          .returning({ id: swapOrders.id });
        return rows.length > 0;
      } catch (err) {
        // 23505: a mesma transferencia ja provou outro pedido.
        if ((err as { code?: string; cause?: { code?: string } }).code === '23505' ||
          (err as { cause?: { code?: string } }).cause?.code === '23505') {
          return false;
        }
        throw err;
      }
    },

    async findOpenSwapOrderByAmountSats(amountSats) {
      const rows = await db
        .select()
        .from(swapOrders)
        .where(
          and(
            eq(swapOrders.amountSats, amountSats),
            inArray(swapOrders.status, [
              'criando',
              'pendente',
              'aguardando_deposito',
              'depositado',
              'trocado',
              'incerto',
            ]),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async listSwapOrdersToReconcile(limit) {
      const rows = await db
        .select()
        .from(swapOrders)
        .where(
          inArray(swapOrders.status, [
            'pendente',
            'aguardando_deposito',
            'depositado',
            'trocado',
            'incerto',
          ]),
        )
        .orderBy(asc(swapOrders.updatedAt))
        .limit(limit);
      return rows;
    },

    async findCashOutChargeById(id) {
      const rows = await db
        .select()
        .from(cashoutCharges)
        .where(eq(cashoutCharges.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findCashOutChargeByIdForClient(id, clientId) {
      const rows = await db
        .select()
        .from(cashoutCharges)
        .where(and(eq(cashoutCharges.id, id), eq(cashoutCharges.clientId, clientId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async findCashOutChargeByClientAndExternalId(clientId, externalId) {
      const rows = await db
        .select()
        .from(cashoutCharges)
        .where(
          and(
            eq(cashoutCharges.clientId, clientId),
            eq(cashoutCharges.externalId, externalId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findCashOutChargeByProviderCashoutId(provider, providerCashoutId) {
      const rows = await db
        .select()
        .from(cashoutCharges)
        .where(
          and(
            eq(cashoutCharges.provider, provider as 'lunium'),
            eq(cashoutCharges.providerCashoutId, providerCashoutId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async updateCashOutCharge(input) {
      const rows = await db
        .update(cashoutCharges)
        .set({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.providerCashoutId !== undefined
            ? { providerCashoutId: input.providerCashoutId }
            : {}),
          ...(input.providerState !== undefined
            ? { providerState: input.providerState }
            : {}),
          ...(input.depositAddress !== undefined
            ? { depositAddress: input.depositAddress }
            : {}),
          ...(input.depositTag !== undefined ? { depositTag: input.depositTag } : {}),
          ...(input.amountAssetMinor !== undefined
            ? { amountAssetMinor: input.amountAssetMinor }
            : {}),
          ...(input.feeTotalCents !== undefined
            ? { feeTotalCents: input.feeTotalCents }
            : {}),
          ...(input.providerPath !== undefined ? { providerPath: input.providerPath } : {}),
          ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
          ...(input.pixE2e !== undefined ? { pixE2e: input.pixE2e } : {}),
          ...(input.pixPaidAt !== undefined ? { pixPaidAt: input.pixPaidAt } : {}),
          ...(input.receiptUrl !== undefined ? { receiptUrl: input.receiptUrl } : {}),
          ...(input.verifyUrl !== undefined ? { verifyUrl: input.verifyUrl } : {}),
          ...(input.refundAddress !== undefined
            ? { refundAddress: input.refundAddress }
            : {}),
          ...(input.providerPayload !== undefined
            ? { providerPayload: input.providerPayload }
            : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
          ...(input.lastCheckedAt !== undefined ? { lastCheckedAt: input.lastCheckedAt } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          ...(input.version !== undefined ? { version: input.version } : {}),
          updatedAt: new Date(),
        })
        .where(eq(cashoutCharges.id, input.id))
        .returning();
      return rows[0] ?? null;
    },

    async reserveCashOutGasTopUp(id, clientId, at) {
      const rows = await db
        .update(cashoutCharges)
        .set({ gasToppedUpAt: at, updatedAt: new Date() })
        .where(
          and(
            eq(cashoutCharges.id, id),
            eq(cashoutCharges.clientId, clientId),
            eq(cashoutCharges.status, 'aguardando_deposito'),
            isNotNull(cashoutCharges.depositAddress),
            isNull(cashoutCharges.txHash),
            isNull(cashoutCharges.gasToppedUpAt),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async finishCashOutGasTopUp(id, txHash) {
      await db
        .update(cashoutCharges)
        .set({ gasTopUpTxHash: txHash, updatedAt: new Date() })
        .where(eq(cashoutCharges.id, id));
    },

    async releaseCashOutGasTopUp(id) {
      await db
        .update(cashoutCharges)
        .set({ gasToppedUpAt: null, gasTopUpTxHash: null, updatedAt: new Date() })
        .where(eq(cashoutCharges.id, id));
    },

    async countCashOutGasTopUpsSince(since) {
      const rows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(cashoutCharges)
        .where(
          and(
            isNotNull(cashoutCharges.gasTopUpTxHash),
            gt(cashoutCharges.gasToppedUpAt, since),
          ),
        );
      return Number(rows[0]?.total ?? 0);
    },

    async hasUnusedCashOutGasTopUp(clientId) {
      const rows = await db
        .select({ id: cashoutCharges.id })
        .from(cashoutCharges)
        .where(
          and(
            eq(cashoutCharges.clientId, clientId),
            isNotNull(cashoutCharges.gasTopUpTxHash),
            isNull(cashoutCharges.txHash),
            inArray(cashoutCharges.status, ['criando', 'pendente', 'aguardando_deposito']),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async listCashOutChargesToReconcile(limit) {
      const rows = await db
        .select()
        .from(cashoutCharges)
        .where(
          inArray(cashoutCharges.status, [
            'criando',
            'pendente',
            'aguardando_deposito',
            'depositado',
            'pago',
            'incerto',
          ]),
        )
        .orderBy(asc(cashoutCharges.updatedAt))
        .limit(limit);
      return rows;
    },

    async listCashOutChargesForOriginAddress(originAddress, limit) {
      const rows = await db
        .select()
        .from(cashoutCharges)
        .where(eq(cashoutCharges.originAddress, originAddress.toLowerCase()))
        .orderBy(desc(cashoutCharges.createdAt))
        .limit(limit);
      return rows;
    },

    async createPossessionChallenge(input) {
      const rows = await db
        .insert(possessionChallenges)
        .values({
          nonce: input.nonce,
          address: input.address.toLowerCase(),
          purpose: input.purpose,
          message: input.message,
          expiresAt: input.expiresAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao criar desafio de posse');
      return row;
    },

    async consumePossessionChallenge(nonce, now) {
      const rows = await db
        .update(possessionChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(possessionChallenges.nonce, nonce),
            isNull(possessionChallenges.consumedAt),
            gt(possessionChallenges.expiresAt, now),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async deleteExpiredPossessionChallenges(now) {
      const rows = await db
        .delete(possessionChallenges)
        .where(lte(possessionChallenges.expiresAt, now))
        .returning({ nonce: possessionChallenges.nonce });
      return rows.length;
    },

    async findClientBySettlementAddress(address) {
      const rows = await db
        .select()
        .from(apiClients)
        .where(eq(apiClients.settlementAddress, address.toLowerCase()))
        .limit(1);
      return rows[0] ?? null;
    },

    async createAddressRevocation(input) {
      const rows = await db
        .insert(addressRevocations)
        .values({
          address: input.address.toLowerCase(),
          merchantId: input.merchantId,
        })
        .onConflictDoUpdate({
          target: [addressRevocations.address, addressRevocations.merchantId],
          set: { revokedAt: new Date() },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao revogar endereco');
      return row;
    },

    async listAddressRevocations(address) {
      return db
        .select()
        .from(addressRevocations)
        .where(eq(addressRevocations.address, address.toLowerCase()));
    },

    async isAddressRevoked(address, merchantId) {
      const rows = await db
        .select({ id: addressRevocations.id })
        .from(addressRevocations)
        .where(
          and(
            eq(addressRevocations.address, address.toLowerCase()),
            eq(addressRevocations.merchantId, merchantId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async getServiceFlag(key) {
      const rows = await db
        .select()
        .from(serviceFlags)
        .where(eq(serviceFlags.key, key))
        .limit(1);
      return rows[0] ?? null;
    },

    async setServiceFlag(key, value) {
      const rows = await db
        .insert(serviceFlags)
        .values({ key, value })
        .onConflictDoUpdate({
          target: serviceFlags.key,
          set: { value, updatedAt: new Date() },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao gravar flag');
      return row;
    },

    async listServiceFlags() {
      return db.select().from(serviceFlags);
    },

    async listPixChargesByDestinationAddress(address, limit, before) {
      const rows = await db
        .select()
        .from(pixCharges)
        .where(
          and(
            eq(pixCharges.destinationAddress, address.toLowerCase()),
            before
              ? or(
                  lt(pixCharges.createdAt, before.createdAt),
                  and(
                    eq(pixCharges.createdAt, before.createdAt),
                    lt(pixCharges.id, before.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(pixCharges.createdAt), desc(pixCharges.id))
        .limit(limit);
      return rows;
    },

    async listCashOutChargesByOriginAddress(address, limit, before) {
      const rows = await db
        .select()
        .from(cashoutCharges)
        .where(
          and(
            eq(cashoutCharges.originAddress, address.toLowerCase()),
            before
              ? or(
                  lt(cashoutCharges.createdAt, before.createdAt),
                  and(
                    eq(cashoutCharges.createdAt, before.createdAt),
                    lt(cashoutCharges.id, before.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(cashoutCharges.createdAt), desc(cashoutCharges.id))
        .limit(limit);
      return rows;
    },

    async findPixChargeById(id) {
      const rows = await db
        .select()
        .from(pixCharges)
        .where(eq(pixCharges.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findPixChargeByIdForClient(id, clientId) {
      const rows = await db
        .select()
        .from(pixCharges)
        .where(and(eq(pixCharges.id, id), eq(pixCharges.clientId, clientId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async findPixChargeByClientAndExternalId(clientId, externalId) {
      const rows = await db
        .select()
        .from(pixCharges)
        .where(
          and(
            eq(pixCharges.clientId, clientId),
            eq(pixCharges.externalId, externalId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findPixChargeByProviderChargeId(provider, providerChargeId) {
      const rows = await db
        .select()
        .from(pixCharges)
        .where(
          and(
            eq(pixCharges.provider, provider as never),
            eq(pixCharges.providerChargeId, providerChargeId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async updatePixCharge(input) {
      const rows = await db
        .update(pixCharges)
        .set({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.settlementStatus !== undefined
            ? { settlementStatus: input.settlementStatus }
            : {}),
          ...(input.providerChargeId !== undefined
            ? { providerChargeId: input.providerChargeId }
            : {}),
          ...(input.providerStatus !== undefined
            ? { providerStatus: input.providerStatus }
            : {}),
          ...(input.providerSettlementStatus !== undefined
            ? { providerSettlementStatus: input.providerSettlementStatus }
            : {}),
          ...(input.qrCopypaste !== undefined
            ? { qrCopypaste: input.qrCopypaste }
            : {}),
          ...(input.qrImageUrl !== undefined
            ? { qrImageUrl: input.qrImageUrl }
            : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          ...(input.paidAt !== undefined ? { paidAt: input.paidAt } : {}),
          ...(input.settledAt !== undefined ? { settledAt: input.settledAt } : {}),
          ...(input.e2e !== undefined ? { e2e: input.e2e } : {}),
          ...(input.payerName !== undefined ? { payerName: input.payerName } : {}),
          ...(input.feeLuniumBps !== undefined
            ? { feeLuniumBps: input.feeLuniumBps }
            : {}),
          ...(input.feeLuniumFixedCents !== undefined
            ? { feeLuniumFixedCents: input.feeLuniumFixedCents }
            : {}),
          ...(input.feePartnerBps !== undefined
            ? { feePartnerBps: input.feePartnerBps }
            : {}),
          ...(input.feeTotalCents !== undefined
            ? { feeTotalCents: input.feeTotalCents }
            : {}),
          ...(input.netCents !== undefined ? { netCents: input.netCents } : {}),
          ...(input.assetAmountMinor !== undefined
            ? { assetAmountMinor: input.assetAmountMinor }
            : {}),
          ...(input.withdrawFee !== undefined
            ? { withdrawFee: input.withdrawFee }
            : {}),
          ...(input.settlementTxHash !== undefined
            ? { settlementTxHash: input.settlementTxHash }
            : {}),
          ...(input.settlementTxUrl !== undefined
            ? { settlementTxUrl: input.settlementTxUrl }
            : {}),
          ...(input.providerPayload !== undefined
            ? { providerPayload: input.providerPayload }
            : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
          ...(input.lastCheckedAt !== undefined
            ? { lastCheckedAt: input.lastCheckedAt }
            : {}),
          ...(input.payoutId !== undefined ? { payoutId: input.payoutId } : {}),
          version: sql`${pixCharges.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(pixCharges.id, input.id))
        .returning();
      return rows[0] ?? null;
    },

    async listPixChargesToReconcile(limit) {
      return db
        .select()
        .from(pixCharges)
        .where(
          inArray(pixCharges.status, ['criando', 'pendente', 'pago', 'incerto']),
        )
        .orderBy(asc(pixCharges.updatedAt))
        .limit(limit);
    },

    async listPixChargesAwaitingPayout(limit) {
      return db
        .select()
        .from(pixCharges)
        .where(
          and(
            eq(pixCharges.status, 'liquidado'),
            eq(pixCharges.settlementStatus, 'convertido'),
            isNull(pixCharges.payoutId),
          ),
        )
        .orderBy(asc(pixCharges.settledAt))
        .limit(limit);
    },

    async listPixCharges(limit) {
      return db
        .select()
        .from(pixCharges)
        .orderBy(asc(pixCharges.createdAt))
        .limit(limit);
    },

    async listPixChargesForMerchant(merchantId, limit) {
      return db
        .select()
        .from(pixCharges)
        .where(eq(pixCharges.clientId, merchantId))
        .orderBy(asc(pixCharges.createdAt))
        .limit(limit);
    },

    async listUnprocessedProviderEvents(provider, limit) {
      return db
        .select({
          id: providerEvents.id,
          eventType: providerEvents.eventType,
          externalId: providerEvents.externalId,
          payload: providerEvents.payload,
        })
        .from(providerEvents)
        .where(
          and(
            eq(providerEvents.provider, provider),
            isNull(providerEvents.processedAt),
          ),
        )
        .orderBy(asc(providerEvents.createdAt))
        .limit(limit);
    },

    async markProviderEventProcessed(id) {
      await db
        .update(providerEvents)
        .set({ processedAt: new Date() })
        .where(eq(providerEvents.id, id));
    },

    async insertProviderEvent(input) {
      const rows = await db
        .insert(providerEvents)
        .values({
          provider: input.provider,
          eventType: input.eventType,
          externalId: input.externalId,
          conversionId: input.conversionId ?? null,
          pixChargeId: input.pixChargeId ?? null,
          payload: input.payload,
        })
        .onConflictDoNothing({
          target: [providerEvents.provider, providerEvents.externalId],
        })
        .returning({ id: providerEvents.id });
      return rows.length > 0;
    },

    async findProviderEvent(provider, externalId) {
      const rows = await db
        .select({ eventType: providerEvents.eventType, payload: providerEvents.payload })
        .from(providerEvents)
        .where(
          and(
            eq(providerEvents.provider, provider),
            eq(providerEvents.externalId, externalId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async hasProviderEvent(provider, externalId) {
      const rows = await db
        .select({ id: providerEvents.id })
        .from(providerEvents)
        .where(
          and(
            eq(providerEvents.provider, provider),
            eq(providerEvents.externalId, externalId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async updateIntentSettlement(input) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, input.intentId))
          .for('update')
          .limit(1);
        const current = locked[0];
        if (!current || !input.from.includes(current.settlementStatus)) return null;
        const rows = await tx
          .update(paymentIntents)
          .set({
            settlementStatus: input.to,
            ...(input.conversionOrderId !== undefined
              ? { conversionOrderId: input.conversionOrderId }
              : {}),
            ...(input.payoutId !== undefined ? { payoutId: input.payoutId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, input.intentId))
          .returning();
        return rows[0] ?? null;
      });
    },

    async createPayout(input) {
      const rows = await db
        .insert(payouts)
        .values({
          merchantId: input.merchantId,
          walletId: input.walletId,
          amountMinor: input.amountMinor,
          idempotencyKey: input.idempotencyKey,
          conversionId: input.conversionId ?? null,
          pixChargeId: input.pixChargeId ?? null,
          destinationAddress: input.destinationAddress ?? null,
          feeMinor: input.feeMinor ?? null,
          status: input.status ?? 'pendente',
          approvedBy: input.approvedBy ?? null,
          lastError: input.lastError ?? null,
        })
        .onConflictDoNothing({ target: payouts.idempotencyKey })
        .returning();
      const created = rows[0];
      if (created) return created;
      const existing = await db
        .select()
        .from(payouts)
        .where(eq(payouts.idempotencyKey, input.idempotencyKey))
        .limit(1);
      const row = existing[0];
      if (!row) throw new Error('falha ao criar payout');
      return row;
    },

    async findPayoutById(id) {
      const rows = await db.select().from(payouts).where(eq(payouts.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async findPayoutByConversionId(conversionId) {
      const rows = await db
        .select()
        .from(payouts)
        .where(eq(payouts.conversionId, conversionId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findPayoutByPixChargeId(pixChargeId) {
      const rows = await db
        .select()
        .from(payouts)
        .where(eq(payouts.pixChargeId, pixChargeId))
        .limit(1);
      return rows[0] ?? null;
    },

    async updatePayout(input) {
      const rows = await db
        .update(payouts)
        .set({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.txid !== undefined ? { txid: input.txid } : {}),
          ...(input.feeMinor !== undefined ? { feeMinor: input.feeMinor } : {}),
          ...(input.approvedBy !== undefined
            ? { approvedBy: input.approvedBy }
            : {}),
          ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
          ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
          ...(input.confirmedAt !== undefined
            ? { confirmedAt: input.confirmedAt }
            : {}),
        })
        .where(eq(payouts.id, input.id))
        .returning();
      return rows[0] ?? null;
    },

    async claimPayoutForSending(id) {
      const rows = await db
        .update(payouts)
        .set({ status: 'enviando' })
        .where(and(eq(payouts.id, id), eq(payouts.status, 'aprovado')))
        .returning();
      return rows[0] ?? null;
    },

    async listPayoutsToSend(limit) {
      return db
        .select()
        .from(payouts)
        .where(eq(payouts.status, 'aprovado'))
        .orderBy(asc(payouts.createdAt))
        .limit(limit);
    },

    async listPayoutsToMonitor(limit) {
      return db
        .select()
        .from(payouts)
        .where(eq(payouts.status, 'enviando'))
        .orderBy(asc(payouts.createdAt))
        .limit(limit);
    },

    async listPayouts(limit) {
      return db
        .select()
        .from(payouts)
        .orderBy(asc(payouts.createdAt))
        .limit(limit);
    },

    async listPayoutsForMerchant(merchantId, limit) {
      return db
        .select()
        .from(payouts)
        .where(eq(payouts.merchantId, merchantId))
        .orderBy(asc(payouts.createdAt))
        .limit(limit);
    },

    async findPayoutByIdForMerchant(id, merchantId) {
      const rows = await db
        .select()
        .from(payouts)
        .where(and(eq(payouts.id, id), eq(payouts.merchantId, merchantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async listTreasuryWallets() {
      return db
        .select()
        .from(treasuryWallets)
        .orderBy(asc(treasuryWallets.createdAt));
    },

    async getSettlementCounts() {
      const conversionRows = await db
        .select({
          status: conversionOrders.status,
          count: sql<string>`count(*)::text`,
        })
        .from(conversionOrders)
        .groupBy(conversionOrders.status);
      const payoutRows = await db
        .select({
          status: payouts.status,
          count: sql<string>`count(*)::text`,
        })
        .from(payouts)
        .groupBy(payouts.status);
      return {
        conversions: Object.fromEntries(
          conversionRows.map((row) => [row.status, Number(row.count)]),
        ),
        payouts: Object.fromEntries(
          payoutRows.map((row) => [row.status, Number(row.count)]),
        ),
      };
    },

    async sumPayoutMinorSince(merchantId, since) {
      const rows = await db
        .select({
          total: sql<string>`coalesce(sum(${payouts.amountMinor}), 0)::text`,
        })
        .from(payouts)
        .where(
          and(
            eq(payouts.merchantId, merchantId),
            gt(payouts.createdAt, since),
            inArray(payouts.status, ['aprovado', 'enviando', 'confirmado']),
          ),
        );
      return BigInt(rows[0]?.total ?? '0');
    },

    async getStatusCounts() {
      const [intents, pixChargeRows, pixProviderEventRows, pixLatencyRows, webhooks, sweeps, pending, due, active] = await Promise.all([
        db.execute<{ status: string; count: number }>(sql`
          select status, count(*)::int as count
          from payment_intents
          group by status
        `),
        db.execute<{ status: string; count: number }>(sql`
          select status, count(*)::int as count
          from pix_charges
          group by status
        `),
        db.execute<{ status: string; count: number }>(sql`
          select case when processed_at is null then 'pendente' else 'processado' end as status,
                 count(*)::int as count
          from provider_events
          where provider = 'lunium'
          group by 1
        `),
        db.execute<{ avg_seconds: string | null }>(sql`
          select avg(extract(epoch from (settled_at - paid_at)))::text as avg_seconds
          from pix_charges
          where settled_at is not null and paid_at is not null
        `),
        db.execute<{ status: string; count: number }>(sql`
          select status, count(*)::int as count
          from webhook_events
          group by status
        `),
        db.execute<{ status: string; count: number }>(sql`
          select status, count(*)::int as count
          from onchain_sweeps
          group by status
        `),
        db.execute<{ count: number }>(sql`
          select count(*)::int as count
          from payment_intents
          where status = 'pendente'
        `),
        db.execute<{ count: number }>(sql`
          select count(*)::int as count
          from webhook_events
          where status = 'pendente' and next_attempt_at <= now()
        `),
        db.execute<{ count: number }>(sql`
          select count(*)::int as count
          from onchain_sweeps
          where status in ('pendente','construindo','assinando','transmitindo','aguardando_confirmacao_rede','manual')
        `),
      ]);
      const toRecord = (rows: Array<{ status: string; count: number }>) =>
        Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
      const balances = await db.execute<{
        client_id: string;
        name: string;
        paid_rail: string;
        paid_amount_sats: string;
      }>(sql`
        select c.id as client_id, c.name, pi.paid_rail,
               coalesce(sum(pi.paid_amount_sats), 0)::text as paid_amount_sats
        from api_clients c
        join payment_intents pi on pi.client_id = c.id
        where pi.status in ('pago', 'pago_tardio')
          and pi.paid_rail is not null
        group by c.id, c.name, pi.paid_rail
        order by c.name, pi.paid_rail
      `);
      return {
        intents: toRecord(intents),
        pixCharges: toRecord(pixChargeRows),
        pixProviderEvents: toRecord(pixProviderEventRows),
        pixSettlementLatencySeconds: Number(pixLatencyRows[0]?.avg_seconds ?? 0),
        webhooks: toRecord(webhooks),
        sweeps: toRecord(sweeps),
        pendingIntents: Number(pending[0]?.count ?? 0),
        dueWebhooks: Number(due[0]?.count ?? 0),
        activeSweeps: Number(active[0]?.count ?? 0),
        clientBalances: balances.map((row) => ({
          clientId: row.client_id,
          name: row.name,
          paidRail: row.paid_rail,
          paidAmountSats: String(row.paid_amount_sats),
        })),
      };
    },

    async insertReconciliationRun(job) {
      const rows = await db
        .insert(reconciliationRuns)
        .values({ job })
        .returning({ id: reconciliationRuns.id });
      const row = rows[0];
      if (!row) throw new Error('falha ao criar execucao de reconciliacao');
      return row;
    },

    async finishReconciliationRun(input) {
      await db
        .update(reconciliationRuns)
        .set({
          ok: input.ok,
          details: input.details,
          finishedAt: new Date(),
        })
        .where(eq(reconciliationRuns.id, input.id));
    },

    async listReconciliationRuns(limit) {
      const rows = await db
        .select()
        .from(reconciliationRuns)
        .orderBy(asc(reconciliationRuns.startedAt))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        job: row.job,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        ok: row.ok,
        details: row.details,
      }));
    },

    async insertAuditEvent(input) {
      await db.insert(auditEvents).values({
        actor: input.actor,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        ip: input.ip ?? null,
        metadata: input.metadata ?? null,
      });
    },
  };
}
