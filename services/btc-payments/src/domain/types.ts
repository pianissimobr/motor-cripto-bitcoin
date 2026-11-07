/**
 * Rede de liquidacao do PIX (a mesma em que a Lunium entrega o USDC).
 *
 * `polygon` e o trilho escolhido: e o que a chave de producao da LuniumPay
 * usa e o que tem o menor custo de saque. `base` continua suportado para as
 * cobrancas ja criadas.
 */
export type SettlementChain = 'base' | 'polygon';

export type PaymentIntentStatus =
  | 'criando'
  | 'pendente'
  | 'pago'
  | 'parcial'
  | 'expirado'
  | 'pago_tardio'
  | 'cancelado'
  | 'reorg'
  | 'falha_criacao';

export type SweepStatus =
  | 'nao_aplicavel'
  | 'aguardando_confirmacao'
  | 'pendente'
  | 'construindo'
  | 'assinando'
  | 'transmitindo'
  | 'aguardando_confirmacao_rede'
  | 'sweepado'
  | 'falhou'
  | 'manual'
  | 'substituido';

export type PaidRail = 'lightning' | 'onchain' | 'both';

export type ClientStatus = 'ativo' | 'inativo';

export type LightningPaymentStatus = 'pendente' | 'pago' | 'expirado' | 'falhou';

export type OnchainPaymentStatus =
  | 'mempool'
  | 'confirmado'
  | 'reorg'
  | 'gasto';

export type WebhookStatus = 'pendente' | 'entregue' | 'falhou';

export type ApiScope =
  | 'payments:write'
  | 'payments:read'
  | 'wallets:read'
  | 'wallets:write'
  | 'balances:read'
  | 'conversions:read'
  | 'payouts:read'
  /** Repor gas (nativo) para a carteira do cliente. */
  | 'gas:write'
  /** Criar e acompanhar vendas de cripto por Pix (cash-out). */
  | 'cashout:write'
  /** Ler as vendas de cripto por Pix. */
  | 'cashout:read'
  /** Ler o extrato de operações do endereço. */
  | 'operations:read';

/**
 * Escopos de um cliente novo. `wallets:write` fica de fora: trocar a carteira
 * desvia os proximos pagamentos, entao uma API key vazada nao pode fazer isso
 * sem o escopo pedido explicitamente. O portal (sessao + CSRF) continua podendo.
 */
export const DEFAULT_API_SCOPES: readonly ApiScope[] = [
  'payments:write',
  'payments:read',
  'wallets:read',
  'balances:read',
  'conversions:read',
  'payouts:read',
];

/**
 * Escopos do cliente de device (perfil pessoal do app).
 *
 * O perfil nao fatura ninguem, nao converte BTC e nao saca: ele compra e
 * vende cripto por Pix, le o proprio extrato e pede gas. `payouts:read` e
 * `conversions:read` ficam de fora de proposito.
 */
export const USER_API_SCOPES: readonly ApiScope[] = [
  'payments:write',
  'payments:read',
  'cashout:write',
  'cashout:read',
  'operations:read',
  'gas:write',
  'wallets:read',
  'balances:read',
];

export type ClientType = 'loja' | 'usuario';

export type VerificationStatus = 'unverified' | 'pending' | 'verified';

export type SettlementStatus =
  | 'nao_iniciado'
  | 'aguardando_confirmacao'
  | 'pronto_para_conversao'
  | 'convertendo'
  | 'convertido'
  | 'payout_pendente'
  | 'pago'
  | 'falhou'
  | 'manual';

export type MerchantWalletKind =
  | 'btc_deposit'
  | 'usdc_settlement'
  | 'btc_cold'
  | 'lightning_lnbits';

export type PixChargeStatus =
  | 'criando'
  | 'pendente'
  | 'pago'
  | 'liquidado'
  | 'expirado'
  | 'reembolsado'
  | 'falhou'
  | 'incerto'
  | 'manual';

export type PixProviderStatus =
  | 'pending'
  | 'delayed'
  | 'under_review'
  | 'paid'
  | 'expired'
  | 'refunded'
  | 'failed';

/**
 * Estado canonico do cash-out (venda de cripto por Pix).
 *
 * O caminho feliz: `criando` -> `aguardando_deposito` (a Lunium ja devolveu o
 * endereco de deposito) -> `depositado` (o app ja enviou) -> `pago` (a Lunium
 * esta vendendo) -> `liquidado` (o Pix caiu). `liquidado` e o unico sucesso.
 */
export type CashOutStatus =
  | 'criando'
  | 'pendente'
  | 'aguardando_deposito'
  | 'depositado'
  | 'pago'
  | 'liquidado'
  | 'expirado'
  | 'reembolsado'
  | 'falhou'
  | 'incerto'
  | 'manual';

/** Estado cru da Lunium numa ordem de cash-out. */
export type CashOutProviderState =
  | 'QUOTE_CREATED'
  | 'AWAITING_DEPOSIT'
  | 'DEPOSIT_DETECTED'
  | 'DEPOSIT_CONFIRMED'
  | 'SELLING'
  | 'SOLD'
  | 'FORWARDING'
  | 'PAYING_OUT'
  | 'COMPLETED'
  | 'MANUAL_REVIEW'
  | 'AWAITING_REFUND_ADDRESS'
  | 'REFUNDING'
  | 'REFUNDING_CRYPTO'
  | 'REFUNDED'
  | 'EXPIRED'
  | 'FAILED'
  | 'DELAYED'
  | 'PROCESSING';

export type PixProviderSettlementStatus =
  | 'pending'
  | 'sending'
  | 'entregando'
  | 'sent'
  | 'incerto'
  | 'failed';

export type FxQuoteStatus = 'ativa' | 'usada' | 'expirada' | 'cancelada';

export type ConversionStatus =
  | 'criada'
  | 'cotando'
  | 'enviando_btc'
  | 'aguardando_swap'
  | 'recebendo_usdc'
  | 'convertida'
  | 'falhou'
  | 'reembolsada'
  | 'manual';

export type ConversionLegKind = 'thorchain' | 'cctp_burn' | 'cctp_mint' | 'payout';

export type ConversionLegStatus =
  | 'pendente'
  | 'enviado'
  | 'confirmado'
  | 'falhou'
  | 'manual';

export type PayoutStatus =
  | 'pendente'
  | 'aprovado'
  | 'enviando'
  | 'confirmado'
  | 'retido'
  | 'falhou'
  | 'cancelado';

export type TreasuryWalletKind = 'btc_hot' | 'btc_cold' | 'usdc_hot' | 'gas_base';

export type ApiClient = {
  id: string;
  name: string;
  apiKeyPrefix: string;
  apiKeyHash: string;
  requestSecretEnc: string;
  webhookUrl: string;
  webhookSecretEnc: string;
  status: ClientStatus;
  scopes: ApiScope[];
  baseCurrency: 'BRL' | 'USD';
  settlementAsset: 'USDC';
  settlementChain: SettlementChain;
  /** `loja` (site) ou `usuario` (app). */
  clientType: 'loja' | 'usuario';
  /** Endereco EVM do cliente (USDC/Polygon). */
  settlementAddress: string | null;
  spreadBps: number;
  autoPayoutLimitBrl: bigint;
  autoPayoutLimitUsd: bigint;
  unverifiedDailyLimitBrl: bigint;
  unverifiedTotalLimitBrl: bigint;
  verificationStatus: VerificationStatus;
  payoutBatchSeconds: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PaymentIntent = {
  id: string;
  clientId: string;
  externalId: string;
  amountSats: bigint;
  description: string | null;
  status: PaymentIntentStatus;
  expiresAt: Date;
  graceUntil: Date;
  paidAt: Date | null;
  paidRail: PaidRail | null;
  paidAmountSats: bigint | null;
  overpaidSats: bigint | null;
  lightningPaymentHash: string | null;
  lightningWalletId: string | null;
  lightningInvoice: string | null;
  lightningExpiresAt: Date | null;
  onchainAddressId: string | null;
  merchantWalletId: string | null;
  currency: 'BRL' | 'USD' | null;
  amountFiat: bigint | null;
  fxQuoteId: string | null;
  settlementStatus: SettlementStatus;
  conversionOrderId: string | null;
  payoutId: string | null;
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type HdAddress = {
  id: string;
  index: number;
  address: string;
  derivationPath: string;
  intentId: string | null;
  status: 'alocada' | 'usada' | 'abandonada' | 'sweepada';
  createdAt: Date;
  usedAt: Date | null;
};

export type LightningPayment = {
  id: string;
  intentId: string;
  paymentHash: string;
  invoice: string;
  amountSats: bigint;
  status: LightningPaymentStatus;
  paidAt: Date | null;
  raw: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OnchainPayment = {
  id: string;
  intentId: string;
  addressId: string;
  txid: string;
  vout: number;
  amountSats: bigint;
  blockHeight: number | null;
  blockHash: string | null;
  confirmations: number;
  status: OnchainPaymentStatus;
  firstSeenAt: Date;
  confirmedAt: Date | null;
  updatedAt: Date;
};

export type SweepInput = {
  txid: string;
  vout: number;
  amountSats: string;
};

export type OnchainSweep = {
  id: string;
  intentId: string;
  addressId: string;
  txid: string | null;
  amountSats: bigint;
  feeSats: bigint | null;
  coldWalletAddress: string | null;
  inputs: SweepInput[];
  confirmations: number;
  status: SweepStatus;
  psbt: string | null;
  rawTx: string | null;
  attempts: number;
  lastError: string | null;
  lastCheckedAt: Date | null;
  lastBroadcastAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WebhookEvent = {
  id: string;
  clientId: string;
  intentId: string | null;
  pixChargeId: string | null;
  eventType: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  status: WebhookStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
};

export type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export type MerchantWallet = {
  id: string;
  merchantId: string | null;
  kind: MerchantWalletKind;
  /** `loja` (liquidacao da loja) ou `cliente` (endereco de um cliente, F4). */
  purpose: 'loja' | 'cliente';
  chain: string;
  network: string;
  address: string;
  xpub: string | null;
  derivationPrefix: string | null;
  lnbitsUrl: string | null;
  secretEnc: string | null;
  status: 'ativo' | 'inativo';
  createdAt: Date;
  updatedAt: Date;
};

export type FxQuote = {
  id: string;
  merchantId: string;
  baseCurrency: 'BRL' | 'USD';
  quoteAsset: 'BTC';
  amountIn: bigint;
  amountOut: bigint;
  rate: string;
  spreadBps: number;
  source: string;
  expiresAt: Date;
  status: FxQuoteStatus;
  createdAt: Date;
};

export type ConversionOrder = {
  id: string;
  merchantId: string;
  intentId: string;
  fxQuoteId: string | null;
  sourceAsset: 'BTC';
  sourceAmountSats: bigint;
  targetAsset: 'USDC';
  targetChain: string;
  targetAmountMinor: bigint | null;
  provider: string;
  providerOrderId: string | null;
  inboundAddress: string | null;
  memo: string | null;
  quoteExpiresAt: Date | null;
  providerPayload: Record<string, unknown> | null;
  status: ConversionStatus;
  feeSats: bigint | null;
  feeMinor: bigint | null;
  txids: string[];
  error: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ConversionLeg = {
  id: string;
  conversionId: string;
  leg: ConversionLegKind;
  provider: string;
  status: ConversionLegStatus;
  txid: string | null;
  providerRef: string | null;
  amountIn: bigint | null;
  amountOut: bigint | null;
  feeMinor: bigint | null;
  createdAt: Date;
  updatedAt: Date;
};

export type Payout = {
  id: string;
  merchantId: string;
  conversionId: string | null;
  pixChargeId: string | null;
  walletId: string | null;
  asset: 'USDC';
  chain: SettlementChain;
  amountMinor: bigint;
  feeMinor: bigint | null;
  status: PayoutStatus;
  txid: string | null;
  idempotencyKey: string;
  destinationAddress: string | null;
  approvedBy: string | null;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
  confirmedAt: Date | null;
};

export type PixCharge = {
  id: string;
  clientId: string;
  externalId: string;
  provider: 'lunium';
  providerExternalId: string;
  providerChargeId: string | null;
  providerStatus: PixProviderStatus | null;
  providerSettlementStatus: PixProviderSettlementStatus | null;
  status: PixChargeStatus;
  settlementStatus: SettlementStatus;
  amountBrlCents: bigint;
  asset: 'USDC';
  chain: SettlementChain;
  destinationAddress: string | null;
  qrCopypaste: string | null;
  qrImageUrl: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  settledAt: Date | null;
  e2e: string | null;
  payerName: string | null;
  payerTaxHash: string | null;
  payerTaxLast4: string | null;
  feeLuniumBps: number | null;
  feeLuniumFixedCents: bigint | null;
  feePartnerBps: number | null;
  feeTotalCents: bigint | null;
  netCents: bigint | null;
  assetAmountMinor: bigint | null;
  withdrawFee: string | null;
  settlementTxHash: string | null;
  settlementTxUrl: string | null;
  providerPayload: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  lastCheckedAt: Date | null;
  payoutId: string | null;
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Linha de uma venda de cripto por Pix (cash-out). */
export type CashOutCharge = {
  id: string;
  clientId: string;
  externalId: string;
  provider: 'lunium';
  providerExternalId: string;
  providerCashoutId: string | null;
  providerState: CashOutProviderState | null;
  status: CashOutStatus;
  amountBrlCents: bigint;
  asset: 'USDC';
  network: 'polygon';
  originAddress: string;
  depositAddress: string | null;
  depositTag: string | null;
  amountAssetMinor: bigint | null;
  feeTotalCents: bigint | null;
  pixKeyMasked: string | null;
  pixKeyType: string | null;
  brCode: string | null;
  providerPath: string | null;
  txHash: string | null;
  pixE2e: string | null;
  pixPaidAt: Date | null;
  receiptUrl: string | null;
  verifyUrl: string | null;
  refundAddress: string | null;
  providerPayload: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  lastCheckedAt: Date | null;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LedgerAccount = {
  id: string;
  merchantId: string | null;
  code: string;
  asset: 'BTC' | 'BRL' | 'USD' | 'USDC';
  kind: 'asset' | 'liability' | 'revenue' | 'expense' | 'equity';
  createdAt: Date;
};

/**
 * Estados canonicos do swap (Bitcoin -> dolar digital).
 *
 * `trocado` e o provedor dizer que entregou; `liquidado` e a nossa prova
 * on-chain. So `liquidado` e sucesso.
 */
export type SwapStatus =
  | 'criando'
  | 'pendente'
  | 'aguardando_deposito'
  | 'depositado'
  | 'trocado'
  | 'liquidado'
  | 'expirado'
  | 'reembolsado'
  | 'falhou'
  | 'incerto'
  | 'manual';

/** Estado cru da SwapKit no rastreio de um swap. */
export type SwapProviderState =
  | 'pending'
  | 'waiting'
  | 'created'
  | 'new'
  | 'awaiting_deposit'
  | 'deposit_pending'
  | 'funding'
  | 'deposited'
  | 'deposit_detected'
  | 'deposit_confirmed'
  | 'swapping'
  | 'swapped'
  | 'swap_completed'
  | 'completed'
  | 'failed'
  | 'error'
  | 'refunded'
  | 'refund'
  | 'expired'
  | 'manual_review'
  | 'under_review';

/** Linha de um pedido de pagamento em Bitcoin que vira dolar digital. */
export type SwapOrder = {
  id: string;
  clientId: string;
  externalId: string;
  provider: 'swapkit';
  providerOrderId: string | null;
  providerState: SwapProviderState | null;
  status: SwapStatus;
  /** Valor em centavos da moeda de cotacao (BRL ou USD). */
  amountFiatCents: bigint;
  currency: 'BRL' | 'USD';
  /** Quanto o pagador deve enviar em BTC, em sats. */
  amountSats: bigint;
  /** Ativo que o pagador envia. */
  sellAsset: string;
  /** Ativo que o cliente recebe (USDC nativo na Polygon). */
  buyAsset: string;
  network: 'polygon';
  /** Carteira que recebe o USDC. */
  destinationAddress: string;
  /** Endereco de BTC do pagador (unico por pedido). */
  depositAddress: string | null;
  depositChannelId: string | null;
  /** Quanto o USDC deve chegar (unidades minimas de 6 casas). */
  expectedAssetMinor: bigint | null;
  feeTotalBps: number | null;
  expiresAt: Date | null;
  providerPayload: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  lastCheckedAt: Date | null;
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LedgerEntryInput = {
  accountCode: string;
  merchantId?: string | null;
  asset: LedgerAccount['asset'];
  debitMinor?: bigint;
  creditMinor?: bigint;
};

export type LedgerTransaction = {
  id: string;
  kind: string;
  referenceType: string;
  referenceId: string;
  createdAt: Date;
};

export type TreasuryWallet = {
  id: string;
  kind: TreasuryWalletKind;
  chain: string;
  network: string;
  address: string;
  xpub: string | null;
  status: 'ativo' | 'inativo';
  createdAt: Date;
  updatedAt: Date;
};

export function parseDecimalToMinor(value: string, decimals = 6): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error('valor decimal invalido');
  }
  const [whole, fraction = ''] = normalized.split('.');
  const padded = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

export type UserStatus = 'pendente_email' | 'ativo' | 'bloqueado';

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MerchantMemberRole = 'owner' | 'admin' | 'member';

export type MerchantMember = {
  userId: string;
  merchantId: string;
  role: MerchantMemberRole;
  createdAt: Date;
};

export type Session = {
  id: string;
  userId: string;
  tokenHash: string;
  csrfTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

export type SubscriptionInterval = 'day' | 'week' | 'month';
export type SubscriptionStatus = 'ativa' | 'pausada' | 'cancelada' | 'falha';

export type Subscription = {
  id: string;
  merchantId: string;
  name: string;
  amountSats: bigint;
  description: string | null;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  externalId: string | null;
  metadata: Record<string, unknown> | null;
  nextChargeAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type SubscriptionCharge = {
  id: string;
  subscriptionId: string;
  intentId: string | null;
  periodStart: Date;
  periodEnd: Date;
  status: 'criada' | 'paga' | 'falhou';
  attemptedAt: Date;
  createdAt: Date;
};

export type PossessionPurpose = 'client_registration' | 'wallet_registration';

export type PossessionChallenge = {
  id: string;
  nonce: string;
  address: string;
  purpose: PossessionPurpose;
  message: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export type AddressRevocation = {
  id: string;
  address: string;
  merchantId: string | null;
  revokedAt: Date;
  createdAt: Date;
};

export type ServiceFlag = {
  key: string;
  value: Record<string, unknown>;
  updatedAt: Date;
};
