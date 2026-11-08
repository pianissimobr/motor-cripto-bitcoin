export type Overview = {
  period: string;
  since: string;
  currency: string;
  received_cents: string;
  payments_created: number;
  payments_paid: number;
  conversion_rate: number | null;
  by_rail: { rail: string; created: number; paid: number; received_cents: string }[];
  series: { day: string; rail: string; received_cents: string; count: number }[];
};

export type PaymentKind = 'pix' | 'bitcoin' | 'request';

export type PaymentItem = {
  id: string;
  kind: PaymentKind;
  external_id: string;
  status: string;
  amount_cents: string;
  currency: string;
  destination_address: string | null;
  tx_hash: string | null;
  created_at: string;
  paid_at: string | null;
};

export type PaymentPage = { items: PaymentItem[]; next_cursor: string | null };

export type Wallet = {
  id: string;
  label: string | null;
  address: string;
  chain: string;
  asset: string;
  is_default: boolean;
  created_at: string;
};

export type Integration = {
  api_key_prefix: string;
  webhook_url: string | null;
  api_base_url: string;
  scopes: string[];
};

export type WebhookEvent = {
  id: string;
  event: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
  next_attempt_at: string | null;
};

export type MerchantView = {
  id: string;
  name: string;
  status: string;
  base_currency: string;
  settlement_asset: string;
  settlement_chain: string;
  created_at: string;
};
