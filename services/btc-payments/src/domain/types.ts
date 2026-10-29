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

export type ApiClient = {
  id: string;
  name: string;
  apiKeyPrefix: string;
  apiKeyHash: string;
  requestSecretEnc: string;
  webhookUrl: string;
  webhookSecretEnc: string;
  status: ClientStatus;
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
  lightningInvoice: string | null;
  lightningExpiresAt: Date | null;
  onchainAddressId: string | null;
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
  intentId: string;
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
