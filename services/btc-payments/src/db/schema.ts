import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ApiScope,
  CashOutProviderState,
  ClientStatus,
  LightningPaymentStatus,
  OnchainPaymentStatus,
  PaidRail,
  PaymentIntentStatus,
  SweepStatus,
  SwapProviderState,
  WebhookStatus,
} from '../domain/types.js';

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow();

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow();

export const apiClients = pgTable(
  'api_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    apiKeyPrefix: text('api_key_prefix').notNull(),
    apiKeyHash: text('api_key_hash').notNull(),
    requestSecretEnc: text('request_secret_enc').notNull(),
    webhookUrl: text('webhook_url').notNull(),
    webhookSecretEnc: text('webhook_secret_enc').notNull(),
    status: text('status').$type<ClientStatus>().notNull().default('ativo'),
    scopes: jsonb('scopes')
      .$type<ApiScope[]>()
      .notNull()
      .default(sql`'["payments:write","payments:read","wallets:read","wallets:write","balances:read","conversions:read","payouts:read"]'::jsonb`),
    baseCurrency: text('base_currency').$type<'BRL' | 'USD'>().notNull().default('BRL'),
    settlementAsset: text('settlement_asset').$type<'USDC'>().notNull().default('USDC'),
    settlementChain: text('settlement_chain').$type<'base' | 'polygon'>().notNull().default('base'),
    /**
     * `loja` (carrinho do site) ou `usuario` (perfil pessoal do app).
     *
     * Nao sao tipos diferentes de cliente: os dois nascem de uma carteira
     * criada no app e recebem um `client_id` (D22). O que muda e de onde vem o
     * destino do cash-in e do cash-out.
     */
    clientType: text('client_type').$type<'loja' | 'usuario'>().notNull().default('loja'),
    /**
     * Endereco EVM do cliente (USDC/Polygon).
     *
     * E o destino do cash-in (a Lunium entrega aqui) e a origem do cash-out
     * (o USDC sai daqui). Fica no cliente — e nao em `merchant_wallets` — porque
     * o mesmo endereco pode ser o de uma loja e o de uma pessoa (D18/D20).
     */
    settlementAddress: text('settlement_address'),
    spreadBps: integer('spread_bps').notNull().default(100),
    autoPayoutLimitBrl: bigint('auto_payout_limit_brl', { mode: 'bigint' })
      .notNull()
      .default(sql`1000000`),
    autoPayoutLimitUsd: bigint('auto_payout_limit_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`200000`),
    unverifiedDailyLimitBrl: bigint('unverified_daily_limit_brl', {
      mode: 'bigint',
    })
      .notNull()
      .default(sql`1000000`),
    unverifiedTotalLimitBrl: bigint('unverified_total_limit_brl', {
      mode: 'bigint',
    })
      .notNull()
      .default(sql`1000000`),
    verificationStatus: text('verification_status')
      .$type<'unverified' | 'pending' | 'verified'>()
      .notNull()
      .default('unverified'),
    payoutBatchSeconds: integer('payout_batch_seconds').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('api_clients_key_hash_uq').on(table.apiKeyHash),
    index('api_clients_prefix_idx').on(table.apiKeyPrefix),
    // O mesmo endereco pode ser de uma loja e de uma pessoa (D20): o indice
    // e por endereco, nao por par (cliente, endereco).
    uniqueIndex('api_clients_settlement_address_uq')
      .on(table.settlementAddress)
      .where(sql`${table.settlementAddress} is not null`),
    check(
      'api_clients_status_chk',
      sql`${table.status} in ('ativo', 'inativo')`,
    ),
    check(
      'api_clients_verification_chk',
      sql`${table.verificationStatus} in ('unverified', 'pending', 'verified')`,
    ),
    check(
      'api_clients_base_currency_chk',
      sql`${table.baseCurrency} in ('BRL', 'USD')`,
    ),
    check(
      'api_clients_settlement_asset_chk',
      sql`${table.settlementAsset} in ('USDC')`,
    ),
    check(
      'api_clients_payout_batch_chk',
      sql`${table.payoutBatchSeconds} >= 0`,
    ),
  ],
);

export const apiNonces = pgTable(
  'api_nonces',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    nonce: text('nonce').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.nonce] }),
    index('api_nonces_expires_idx').on(table.expiresAt),
  ],
);

export const merchantWallets = pgTable(
  'merchant_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id').references(() => apiClients.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind')
      .$type<'btc_deposit' | 'usdc_settlement' | 'btc_cold' | 'lightning_lnbits'>()
      .notNull(),
    chain: text('chain').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    xpub: text('xpub'),
    /**
     * Para quem e a carteira `usdc_settlement`.
     *
     * `loja`: a carteira de liquidacao da propria loja (o PIX que a loja
     * cobra cai nela). `cliente`: o endereco de um cliente que a loja
     * cadastrou para liquidar a compra dele (F4) — esse exige prova de posse.
     */
    purpose: text('purpose')
      .$type<'loja' | 'cliente'>()
      .notNull()
      .default('loja'),
    /** URL da instancia LNbits do lojista (so `lightning_lnbits`). */
    lnbitsUrl: text('lnbits_url'),
    /** Invoice key da wallet LNbits do lojista, cifrada (so `lightning_lnbits`). */
    secretEnc: text('secret_enc'),
    derivationPrefix: text('derivation_prefix'),
    status: text('status').$type<'ativo' | 'inativo'>().notNull().default('ativo'),
    /** Apelido dado pelo lojista no painel (ex.: "MetaMask da loja"). */
    label: text('label'),
    /** Carteira padrao da loja na rede: recebe quando a cobranca nao escolhe. */
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('merchant_wallets_merchant_idx').on(table.merchantId),
    uniqueIndex('merchant_wallets_default_uq')
      .on(table.merchantId, table.kind, table.chain)
      .where(sql`${table.isDefault} and ${table.status} = 'ativo'`),
    index('merchant_wallets_kind_idx').on(table.kind, table.status),
    uniqueIndex('merchant_wallets_chain_address_uq').on(
      table.chain,
      table.address,
    ),
    check(
      'merchant_wallets_kind_chk',
      sql`${table.kind} in ('btc_deposit', 'usdc_settlement', 'btc_cold', 'lightning_lnbits')`,
    ),
    check(
      'merchant_wallets_purpose_chk',
      sql`${table.purpose} in ('loja', 'cliente')`,
    ),
    check(
      'merchant_wallets_status_chk',
      sql`${table.status} in ('ativo', 'inativo')`,
    ),
  ],
);

export const merchantWalletState = pgTable(
  'merchant_wallet_state',
  {
    walletId: uuid('wallet_id')
      .primaryKey()
      .references(() => merchantWallets.id, { onDelete: 'cascade' }),
    nextReceiveIndex: integer('next_receive_index').notNull().default(0),
    gapLimit: integer('gap_limit').notNull().default(20),
    xpubFingerprint: text('xpub_fingerprint').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'merchant_wallet_state_next_index_chk',
      sql`${table.nextReceiveIndex} >= 0`,
    ),
    check('merchant_wallet_state_gap_limit_chk', sql`${table.gapLimit} > 0`),
  ],
);

export const hdWalletState = pgTable(
  'hd_wallet_state',
  {
    id: integer('id').primaryKey(),
    nextReceiveIndex: integer('next_receive_index').notNull().default(0),
    gapLimit: integer('gap_limit').notNull().default(20),
    xpubFingerprint: text('xpub_fingerprint').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [check('hd_wallet_state_singleton_chk', sql`${table.id} = 1`)],
);

export const hdAddresses = pgTable(
  'hd_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    index: integer('index').notNull(),
    address: text('address').notNull(),
    derivationPath: text('derivation_path').notNull(),
    merchantWalletId: uuid('merchant_wallet_id').references(
      () => merchantWallets.id,
      { onDelete: 'set null' },
    ),
    intentId: uuid('intent_id'),
    status: text('status')
      .$type<'alocada' | 'usada' | 'abandonada' | 'sweepada'>()
      .notNull()
      .default('alocada'),
    createdAt: createdAt(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('hd_addresses_wallet_index_uq')
      .on(table.merchantWalletId, table.index)
      .where(sql`${table.merchantWalletId} is not null`),
    uniqueIndex('hd_addresses_default_index_uq')
      .on(table.index)
      .where(sql`${table.merchantWalletId} is null`),
    uniqueIndex('hd_addresses_address_uq').on(table.address),
    uniqueIndex('hd_addresses_intent_uq').on(table.intentId),
    check(
      'hd_addresses_status_chk',
      sql`${table.status} in ('alocada', 'usada', 'abandonada', 'sweepada')`,
    ),
  ],
);

export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    amountSats: bigint('amount_sats', { mode: 'bigint' }).notNull(),
    description: text('description'),
    status: text('status')
      .$type<PaymentIntentStatus>()
      .notNull()
      .default('criando'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    graceUntil: timestamp('grace_until', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    paidRail: text('paid_rail').$type<PaidRail>(),
    paidAmountSats: bigint('paid_amount_sats', { mode: 'bigint' }),
    overpaidSats: bigint('overpaid_sats', { mode: 'bigint' }),
    lightningPaymentHash: text('lightning_payment_hash'),
    /** Wallet LNbits do lojista onde a invoice foi criada (e onde se confere). */
    lightningWalletId: uuid('lightning_wallet_id'),
    lightningInvoice: text('lightning_invoice'),
    lightningExpiresAt: timestamp('lightning_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    onchainAddressId: uuid('onchain_address_id').references(
      () => hdAddresses.id,
      { onDelete: 'set null' },
    ),
    merchantWalletId: uuid('merchant_wallet_id').references(
      () => merchantWallets.id,
      { onDelete: 'set null' },
    ),
    currency: text('currency').$type<'BRL' | 'USD'>(),
    amountFiat: bigint('amount_fiat', { mode: 'bigint' }),
    fxQuoteId: uuid('fx_quote_id'),
    settlementStatus: text('settlement_status')
      .$type<
        | 'nao_iniciado'
        | 'aguardando_confirmacao'
        | 'pronto_para_conversao'
        | 'convertendo'
        | 'convertido'
        | 'payout_pendente'
        | 'pago'
        | 'falhou'
        | 'manual'
      >()
      .notNull()
      .default('nao_iniciado'),
    conversionOrderId: uuid('conversion_order_id'),
    payoutId: uuid('payout_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('payment_intents_client_external_uq').on(
      table.clientId,
      table.externalId,
    ),
    uniqueIndex('payment_intents_lightning_hash_uq').on(
      table.lightningPaymentHash,
    ),
    index('payment_intents_status_expires_idx').on(
      table.status,
      table.expiresAt,
    ),
    index('payment_intents_status_grace_idx').on(table.status, table.graceUntil),
    index('payment_intents_merchant_wallet_idx').on(table.merchantWalletId),
    index('payment_intents_settlement_status_idx').on(table.settlementStatus),
    check(
      'payment_intents_status_chk',
      sql`${table.status} in ('criando','pendente','pago','parcial','expirado','pago_tardio','cancelado','reorg','falha_criacao')`,
    ),
    check(
      'payment_intents_settlement_status_chk',
      sql`${table.settlementStatus} in ('nao_iniciado','aguardando_confirmacao','pronto_para_conversao','convertendo','convertido','payout_pendente','pago','falhou','manual')`,
    ),
    check(
      'payment_intents_currency_chk',
      sql`${table.currency} is null or ${table.currency} in ('BRL','USD')`,
    ),
    check(
      'payment_intents_amount_fiat_chk',
      sql`${table.amountFiat} is null or ${table.amountFiat} > 0`,
    ),
    check(
      'payment_intents_paid_rail_chk',
      sql`${table.paidRail} is null or ${table.paidRail} in ('lightning','onchain','both')`,
    ),
    check('payment_intents_amount_chk', sql`${table.amountSats} > 0`),
  ],
);

export const lightningPayments = pgTable(
  'lightning_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'cascade' }),
    paymentHash: text('payment_hash').notNull(),
    invoice: text('invoice').notNull(),
    amountSats: bigint('amount_sats', { mode: 'bigint' }).notNull(),
    status: text('status')
      .$type<LightningPaymentStatus>()
      .notNull()
      .default('pendente'),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    raw: jsonb('raw').$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('lightning_payments_hash_uq').on(table.paymentHash),
    index('lightning_payments_intent_idx').on(table.intentId),
    check(
      'lightning_payments_status_chk',
      sql`${table.status} in ('pendente','pago','expirado','falhou')`,
    ),
  ],
);

export const onchainPayments = pgTable(
  'onchain_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'cascade' }),
    addressId: uuid('address_id')
      .notNull()
      .references(() => hdAddresses.id, { onDelete: 'restrict' }),
    txid: text('txid').notNull(),
    vout: integer('vout').notNull(),
    amountSats: bigint('amount_sats', { mode: 'bigint' }).notNull(),
    blockHeight: integer('block_height'),
    blockHash: text('block_hash'),
    confirmations: integer('confirmations').notNull().default(0),
    status: text('status')
      .$type<OnchainPaymentStatus>()
      .notNull()
      .default('mempool'),
    firstSeenAt: timestamp('first_seen_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('onchain_payments_txid_vout_uq').on(table.txid, table.vout),
    index('onchain_payments_intent_idx').on(table.intentId),
    index('onchain_payments_address_idx').on(table.addressId),
    check(
      'onchain_payments_status_chk',
      sql`${table.status} in ('mempool','confirmado','reorg','gasto')`,
    ),
    check('onchain_payments_vout_chk', sql`${table.vout} >= 0`),
    check('onchain_payments_amount_chk', sql`${table.amountSats} > 0`),
  ],
);

export const onchainSweeps = pgTable(
  'onchain_sweeps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'cascade' }),
    addressId: uuid('address_id')
      .notNull()
      .references(() => hdAddresses.id, { onDelete: 'restrict' }),
    txid: text('txid'),
    amountSats: bigint('amount_sats', { mode: 'bigint' }).notNull(),
    feeSats: bigint('fee_sats', { mode: 'bigint' }),
    coldWalletAddress: text('cold_wallet_address'),
    inputs: jsonb('inputs')
      .$type<Array<{ txid: string; vout: number; amountSats: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    confirmations: integer('confirmations').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    lastBroadcastAt: timestamp('last_broadcast_at', {
      withTimezone: true,
      mode: 'date',
    }),
    status: text('status')
      .$type<SweepStatus>()
      .notNull()
      .default('pendente'),
    psbt: text('psbt'),
    rawTx: text('raw_tx'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('onchain_sweeps_txid_uq').on(table.txid),
    index('onchain_sweeps_status_idx').on(table.status),
    index('onchain_sweeps_intent_idx').on(table.intentId),
    check(
      'onchain_sweeps_status_chk',
      sql`${table.status} in ('nao_aplicavel','aguardando_confirmacao','pendente','construindo','assinando','transmitindo','aguardando_confirmacao_rede','sweepado','falhou','manual','substituido')`,
    ),
  ],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    intentId: uuid('intent_id').references(() => paymentIntents.id, {
      onDelete: 'cascade',
    }),
    pixChargeId: uuid('pix_charge_id').references(() => pixCharges.id, {
      onDelete: 'cascade',
    }),
    cashoutChargeId: uuid('cashout_charge_id').references(() => cashoutCharges.id, {
      onDelete: 'cascade',
    }),
    /** Fatura hospedada que gerou o IPN (eventos `invoice.*`). */
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'cascade' }),
    /**
     * Destino proprio do evento (o `ipn_callback_url` da fatura). Sem ele, o
     * webhook da loja.
     */
    targetUrl: text('target_url'),
    /** Chave de loja cujo segredo IPN assina o evento (sem ela, o da loja). */
    storeKeyId: uuid('store_key_id').references(() => storeKeys.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status')
      .$type<WebhookStatus>()
      .notNull()
      .default('pendente'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAt(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('webhook_events_dedupe_uq').on(table.dedupeKey),
    index('webhook_events_due_idx').on(table.status, table.nextAttemptAt),
    index('webhook_events_intent_idx').on(table.intentId),
    index('webhook_events_pix_charge_idx').on(table.pixChargeId),
    check(
      'webhook_events_source_chk',
      // No maximo uma cobranca de origem; eventos da propria loja (ex.:
      // merchant.wallet_changed) nao tem cobranca.
      sql`((${table.intentId} is not null)::int + (${table.pixChargeId} is not null)::int) <= 1`,
    ),
    check(
      'webhook_events_status_chk',
      sql`${table.status} in ('pendente','entregue','falhou')`,
    ),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    ip: text('ip'),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
  },
  (table) => [
    index('audit_events_entity_idx').on(table.entity, table.entityId),
    index('audit_events_created_idx').on(table.createdAt),
  ],
);

export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    job: text('job').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    ok: boolean('ok'),
    details: jsonb('details').$type<Record<string, unknown> | null>(),
  },
  (table) => [index('reconciliation_runs_job_idx').on(table.job, table.startedAt)],
);

export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    baseCurrency: text('base_currency').$type<'BTC' | 'BRL' | 'USD'>().notNull(),
    quoteCurrency: text('quote_currency').$type<'BTC' | 'BRL' | 'USD'>().notNull(),
    rate: numeric('rate', { precision: 38, scale: 18 }).notNull(),
    source: text('source').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('fx_rates_pair_idx').on(
      table.baseCurrency,
      table.quoteCurrency,
      table.observedAt,
    ),
    check(
      'fx_rates_currency_chk',
      sql`${table.baseCurrency} in ('BTC','BRL','USD') and ${table.quoteCurrency} in ('BTC','BRL','USD')`,
    ),
    check('fx_rates_positive_chk', sql`${table.rate} > 0`),
  ],
);

export const fxQuotes = pgTable(
  'fx_quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    baseCurrency: text('base_currency').$type<'BRL' | 'USD'>().notNull(),
    quoteAsset: text('quote_asset').$type<'BTC'>().notNull(),
    amountIn: bigint('amount_in', { mode: 'bigint' }).notNull(),
    amountOut: bigint('amount_out', { mode: 'bigint' }).notNull(),
    rate: numeric('rate', { precision: 38, scale: 18 }).notNull(),
    spreadBps: integer('spread_bps').notNull().default(0),
    source: text('source').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status')
      .$type<'ativa' | 'usada' | 'expirada' | 'cancelada'>()
      .notNull()
      .default('ativa'),
    createdAt: createdAt(),
  },
  (table) => [
    index('fx_quotes_merchant_idx').on(table.merchantId),
    index('fx_quotes_status_expires_idx').on(table.status, table.expiresAt),
    check(
      'fx_quotes_currency_chk',
      sql`${table.baseCurrency} in ('BRL','USD') and ${table.quoteAsset} in ('BTC')`,
    ),
    check('fx_quotes_amounts_chk', sql`${table.amountIn} > 0 and ${table.amountOut} > 0`),
    check('fx_quotes_spread_chk', sql`${table.spreadBps} >= 0`),
    check(
      'fx_quotes_status_chk',
      sql`${table.status} in ('ativa','usada','expirada','cancelada')`,
    ),
  ],
);

export const conversionOrders = pgTable(
  'conversion_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'cascade' }),
    fxQuoteId: uuid('fx_quote_id').references(() => fxQuotes.id, {
      onDelete: 'set null',
    }),
    sourceAsset: text('source_asset').$type<'BTC'>().notNull().default('BTC'),
    sourceAmountSats: bigint('source_amount_sats', {
      mode: 'bigint',
    }).notNull(),
    targetAsset: text('target_asset').$type<'USDC'>().notNull().default('USDC'),
    targetChain: text('target_chain').notNull().default('base'),
    targetAmountMinor: bigint('target_amount_minor', { mode: 'bigint' }),
    provider: text('provider').notNull(),
    providerOrderId: text('provider_order_id'),
    inboundAddress: text('inbound_address'),
    memo: text('memo'),
    quoteExpiresAt: timestamp('quote_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    providerPayload: jsonb('provider_payload').$type<Record<string, unknown> | null>(),
    status: text('status')
      .$type<
        | 'criada'
        | 'cotando'
        | 'enviando_btc'
        | 'aguardando_swap'
        | 'recebendo_usdc'
        | 'convertida'
        | 'falhou'
        | 'reembolsada'
        | 'manual'
      >()
      .notNull()
      .default('criada'),
    feeSats: bigint('fee_sats', { mode: 'bigint' }),
    feeMinor: bigint('fee_minor', { mode: 'bigint' }),
    txids: jsonb('txids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('conversion_orders_intent_uq').on(table.intentId),
    uniqueIndex('conversion_orders_provider_order_uq').on(
      table.provider,
      table.providerOrderId,
    ),
    index('conversion_orders_merchant_idx').on(table.merchantId),
    index('conversion_orders_status_idx').on(table.status),
    check(
      'conversion_orders_status_chk',
      sql`${table.status} in ('criada','cotando','enviando_btc','aguardando_swap','recebendo_usdc','convertida','falhou','reembolsada','manual')`,
    ),
    check(
      'conversion_orders_asset_chk',
      sql`${table.sourceAsset} in ('BTC') and ${table.targetAsset} in ('USDC')`,
    ),
    check('conversion_orders_amount_chk', sql`${table.sourceAmountSats} > 0`),
  ],
);

export const conversionLegs = pgTable(
  'conversion_legs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversionId: uuid('conversion_id')
      .notNull()
      .references(() => conversionOrders.id, { onDelete: 'cascade' }),
    leg: text('leg')
      .$type<'thorchain' | 'cctp_burn' | 'cctp_mint' | 'payout'>()
      .notNull(),
    provider: text('provider').notNull(),
    status: text('status')
      .$type<'pendente' | 'enviado' | 'confirmado' | 'falhou' | 'manual'>()
      .notNull()
      .default('pendente'),
    txid: text('txid'),
    providerRef: text('provider_ref'),
    amountIn: bigint('amount_in', { mode: 'bigint' }),
    amountOut: bigint('amount_out', { mode: 'bigint' }),
    feeMinor: bigint('fee_minor', { mode: 'bigint' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('conversion_legs_conversion_leg_uq').on(
      table.conversionId,
      table.leg,
    ),
    index('conversion_legs_status_idx').on(table.status),
    check(
      'conversion_legs_leg_chk',
      sql`${table.leg} in ('thorchain','cctp_burn','cctp_mint','payout')`,
    ),
    check(
      'conversion_legs_status_chk',
      sql`${table.status} in ('pendente','enviado','confirmado','falhou','manual')`,
    ),
  ],
);

export const pixCharges = pgTable(
  'pix_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    provider: text('provider').$type<'lunium'>().notNull().default('lunium'),
    providerExternalId: text('provider_external_id').notNull(),
    providerChargeId: text('provider_charge_id'),
    providerStatus: text('provider_status').$type<
      'pending' | 'delayed' | 'under_review' | 'paid' | 'expired' | 'refunded' | 'failed'
    >(),
    providerSettlementStatus: text('provider_settlement_status').$type<
      'pending' | 'sending' | 'entregando' | 'sent' | 'incerto' | 'failed'
    >(),
    status: text('status')
      .$type<
        | 'criando'
        | 'pendente'
        | 'pago'
        | 'liquidado'
        | 'expirado'
        | 'reembolsado'
        | 'falhou'
        | 'incerto'
        | 'manual'
      >()
      .notNull()
      .default('criando'),
    settlementStatus: text('settlement_status')
      .$type<
        | 'nao_iniciado'
        | 'aguardando_confirmacao'
        | 'pronto_para_conversao'
        | 'convertendo'
        | 'convertido'
        | 'payout_pendente'
        | 'pago'
        | 'falhou'
        | 'manual'
      >()
      .notNull()
      .default('nao_iniciado'),
    amountBrlCents: bigint('amount_brl_cents', { mode: 'bigint' }).notNull(),
    asset: text('asset').$type<'USDC'>().notNull().default('USDC'),
    chain: text('chain').$type<'base' | 'polygon'>().notNull().default('base'),
    destinationAddress: text('destination_address'),
    qrCopypaste: text('qr_copypaste'),
    qrImageUrl: text('qr_image_url'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
    e2e: text('e2e'),
    payerName: text('payer_name'),
    payerTaxHash: text('payer_tax_hash'),
    payerTaxLast4: text('payer_tax_last4'),
    feeLuniumBps: integer('fee_lunium_bps'),
    feeLuniumFixedCents: bigint('fee_lunium_fixed_cents', { mode: 'bigint' }),
    feePartnerBps: integer('fee_partner_bps'),
    feeTotalCents: bigint('fee_total_cents', { mode: 'bigint' }),
    netCents: bigint('net_cents', { mode: 'bigint' }),
    assetAmountMinor: bigint('asset_amount_minor', { mode: 'bigint' }),
    withdrawFee: text('withdraw_fee'),
    settlementTxHash: text('settlement_tx_hash'),
    settlementTxUrl: text('settlement_tx_url'),
    providerPayload: jsonb('provider_payload').$type<Record<string, unknown> | null>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    payoutId: uuid('payout_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('pix_charges_client_external_uq').on(
      table.clientId,
      table.externalId,
    ),
    uniqueIndex('pix_charges_provider_external_uq').on(
      table.provider,
      table.providerExternalId,
    ),
    uniqueIndex('pix_charges_provider_charge_uq').on(
      table.provider,
      table.providerChargeId,
    ),
    index('pix_charges_status_idx').on(table.status),
    index('pix_charges_settlement_status_idx').on(
      table.status,
      table.providerSettlementStatus,
    ),
    index('pix_charges_payout_idx').on(table.payoutId),
    check(
      'pix_charges_status_chk',
      sql`${table.status} in ('criando','pendente','pago','liquidado','expirado','reembolsado','falhou','incerto','manual')`,
    ),
    check(
      'pix_charges_settlement_status_chk',
      sql`${table.settlementStatus} in ('nao_iniciado','aguardando_confirmacao','pronto_para_conversao','convertendo','convertido','payout_pendente','pago','falhou','manual')`,
    ),
    check(
      'pix_charges_provider_status_chk',
      sql`${table.providerStatus} is null or ${table.providerStatus} in ('pending','delayed','under_review','paid','expired','refunded','failed')`,
    ),
    check(
      'pix_charges_provider_settlement_chk',
      sql`${table.providerSettlementStatus} is null or ${table.providerSettlementStatus} in ('pending','sending','entregando','sent','incerto','failed')`,
    ),
    check('pix_charges_amount_chk', sql`${table.amountBrlCents} > 0`),
    check(
      'pix_charges_asset_chk',
      sql`${table.asset} in ('USDC') and ${table.chain} in ('base','polygon')`,
    ),
  ],
);

/**
 * Venda de cripto por Pix (cash-out).
 *
 * O espelho de `pix_charges`: o app pede a venda, a Lunium devolve o endereco
 * de deposito, o app envia o USDC (assinatura local) e a Lunium paga o Pix.
 *
 * `origin_address` e o endereco de onde o USDC sai: e por ele que o extrato
 * agrega as saidas (C5/D20).
 */
export const cashoutCharges = pgTable(
  'cashout_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    provider: text('provider').$type<'lunium'>().notNull().default('lunium'),
    providerExternalId: text('provider_external_id').notNull(),
    providerCashoutId: text('provider_cashout_id'),
    /** Estado cru da Lunium (o que o app ve em `provider_state`). */
    providerState: text('provider_state').$type<CashOutProviderState>(),
    status: text('status')
      .$type<
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
        | 'manual'
      >()
      .notNull()
      .default('criando'),
    amountBrlCents: bigint('amount_brl_cents', { mode: 'bigint' }).notNull(),
    asset: text('asset').$type<'USDC'>().notNull().default('USDC'),
    network: text('network').$type<'polygon'>().notNull().default('polygon'),
    /** Endereco de onde o USDC sai (o agregador do extrato). */
    originAddress: text('origin_address').notNull(),
    /** Endereco de deposito da Lunium: so existe depois do accept. */
    depositAddress: text('deposit_address'),
    depositTag: text('deposit_tag'),
    /** Quantidade a depositar, em unidades atomicas do token. */
    amountAssetMinor: bigint('amount_asset_minor', { mode: 'bigint' }),
    feeTotalCents: bigint('fee_total_cents', { mode: 'bigint' }),
    pixKeyMasked: text('pix_key_masked'),
    pixKeyType: text('pix_key_type'),
    /** BR Code enviado pelo app (o valor e o recebedor vem dentro). */
    brCode: text('br_code'),
    /** Trilho da Lunium: FAST, DEX ou CONVERT. */
    providerPath: text('provider_path'),
    /** Hash da transacao que o app assinou (o motor nao assina). */
    txHash: text('tx_hash'),
    /**
     * Reposicao de gas desta ordem: no maximo uma. A data reserva a vaga
     * antes do envio (update condicional), o que impede duas reposicoes em
     * paralelo para a mesma ordem.
     */
    gasToppedUpAt: timestamp('gas_topped_up_at', { withTimezone: true, mode: 'date' }),
    gasTopUpTxHash: text('gas_topup_tx_hash'),
    pixE2e: text('pix_e2e'),
    pixPaidAt: timestamp('pix_paid_at', { withTimezone: true, mode: 'date' }),
    receiptUrl: text('receipt_url'),
    verifyUrl: text('verify_url'),
    /** Carteira de devolucao, quando a venda falhar. */
    refundAddress: text('refund_address'),
    providerPayload: jsonb('provider_payload').$type<Record<string, unknown> | null>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('cashout_charges_client_external_uq').on(
      table.clientId,
      table.externalId,
    ),
    uniqueIndex('cashout_charges_provider_external_uq').on(
      table.provider,
      table.providerExternalId,
    ),
    uniqueIndex('cashout_charges_provider_cashout_uq').on(
      table.provider,
      table.providerCashoutId,
    ),
    index('cashout_charges_status_idx').on(table.status),
    index('cashout_charges_origin_idx').on(table.originAddress),
    check(
      'cashout_charges_status_chk',
      sql`${table.status} in ('criando','pendente','aguardando_deposito','depositado','pago','liquidado','expirado','reembolsado','falhou','incerto','manual')`,
    ),
    check(
      'cashout_charges_asset_chk',
      sql`${table.asset} in ('USDC') and ${table.network} in ('polygon')`,
    ),
    check('cashout_charges_amount_chk', sql`${table.amountBrlCents} > 0`),
  ],
);

/**
 * Pedido de pagamento em Bitcoin que vira dolar digital.
 *
 * A SwapKit e quem troca: o pagador envia BTC para o `deposit_address` (que
 * e unico por pedido) e a SwapKit entrega o USDC na `destination_address`.
 * O motor nao assina nem move dinheiro: ele cota, guarda o endereco de
 * deposito, acompanha o rastreio e **confere a entrega on-chain** antes de
 * marcar `liquidado`.
 */
export const swapOrders = pgTable(
  'swap_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    provider: text('provider').$type<'swapkit'>().notNull().default('swapkit'),
    providerOrderId: text('provider_order_id'),
    /** Estado cru da SwapKit (o que o app ve em `provider_state`). */
    providerState: text('provider_state').$type<SwapProviderState>(),
    status: text('status')
      .$type<
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
        | 'manual'
      >()
      .notNull()
      .default('criando'),
    amountFiatCents: bigint('amount_fiat_cents', { mode: 'bigint' }).notNull(),
    currency: text('currency').$type<'BRL' | 'USD'>().notNull().default('BRL'),
    /** Quanto o pagador deve enviar, em sats. */
    amountSats: bigint('amount_sats', { mode: 'bigint' }).notNull(),
    sellAsset: text('sell_asset').notNull(),
    buyAsset: text('buy_asset').notNull(),
    network: text('network').$type<'polygon'>().notNull().default('polygon'),
    /** Carteira que recebe o USDC. */
    destinationAddress: text('destination_address').notNull(),
    /** Endereco de BTC do pagador (unico por pedido). */
    depositAddress: text('deposit_address'),
    /** Endereco Bitcoin de origem da rota (quem "vende" o BTC na SwapKit). */
    sourceAddress: text('source_address'),
    depositChannelId: text('deposit_channel_id'),
    /** Quanto o USDC deve chegar (unidades minimas de 6 casas). */
    expectedAssetMinor: bigint('expected_asset_minor', { mode: 'bigint' }),
    /**
     * Bloco da rede do USDC quando o pedido nasceu (gravado pelo motor). Sem o
     * hash da entrega, a prova e um Transfer para o destino a partir daqui.
     */
    startBlock: bigint('start_block', { mode: 'bigint' }),
    /** Transferencia que provou a entrega: uma transferencia, um pedido. */
    deliveryTxHash: text('delivery_tx_hash'),
    deliveryLogIndex: integer('delivery_log_index'),
    feeTotalBps: integer('fee_total_bps'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    providerPayload: jsonb('provider_payload').$type<Record<string, unknown> | null>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('swap_orders_client_external_uq').on(table.clientId, table.externalId),
    uniqueIndex('swap_orders_provider_order_uq').on(table.provider, table.providerOrderId),
    uniqueIndex('swap_orders_deposit_address_uq')
      .on(table.provider, table.depositAddress)
      .where(sql`${table.depositAddress} is not null`),
    index('swap_orders_status_idx').on(table.status),
    index('swap_orders_destination_idx').on(table.destinationAddress),
    uniqueIndex('swap_orders_delivery_uq')
      .on(table.deliveryTxHash, table.deliveryLogIndex)
      .where(sql`${table.deliveryTxHash} is not null`),
    check(
      'swap_orders_status_chk',
      sql`${table.status} in ('criando','pendente','aguardando_deposito','depositado','trocado','liquidado','expirado','reembolsado','falhou','incerto','manual')`,
    ),
    check(
      'swap_orders_currency_chk',
      sql`${table.currency} in ('BRL','USD') and ${table.network} in ('polygon')`,
    ),
    check(
      'swap_orders_amount_chk',
      sql`${table.amountFiatCents} > 0 and ${table.amountSats} > 0`,
    ),
  ],
);

/**
 * Chave Pix do proprio usuario.
 *
 * E o trilho "Pix direto": o usuario configura a chave Pix da conta dele e o
 * pagamento cai direto nela, sem passar pela LuniumPay e sem conversao. O
 * motor so monta o BR Code — quem recebe e o proprio banco do usuario.
 *
 * A chave nao e segredo (e um endereco de pagamento, como o
 * `settlement_address`), mas e dado pessoal: nas respostas da API ela sai
 * mascarada.
 */
export const clientPixKeys = pgTable(
  'client_pix_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    /** Endereco EVM do dono da chave (o mesmo que o do cliente). */
    address: text('address').notNull(),
    pixKey: text('pix_key').notNull(),
    pixKeyType: text('pix_key_type').$type<
      'cpf' | 'cnpj' | 'email' | 'phone' | 'random'
    >(),
    merchantName: text('merchant_name'),
    city: text('city'),
    status: text('status').$type<'ativo' | 'inativo'>().notNull().default('ativo'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('client_pix_keys_client_uq').on(table.clientId),
    index('client_pix_keys_address_idx').on(table.address),
    check(
      'client_pix_keys_status_chk',
      sql`${table.status} in ('ativo','inativo')`,
    ),
  ],
);

/**
 * Pedido de pagamento com mais de um trilho.
 *
 * O site manda o valor e o motor devolve as opcoes: Pix (LuniumPay), Bitcoin
 * que vira dolar digital (SwapKit) e Pix direto (a chave do proprio usuario).
 * Cada trilho tem sua tabela e seu estado; aqui fica o pedido e a ligacao
 * entre eles.
 */
export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    amountFiatCents: bigint('amount_fiat_cents', { mode: 'bigint' }).notNull(),
    currency: text('currency').$type<'BRL' | 'USD'>().notNull().default('BRL'),
    /** Trilhos oferecidos (`pix`, `bitcoin`, `pix_direto`). */
    rails: jsonb('rails').$type<string[]>().notNull(),
    status: text('status')
      .$type<
        | 'criando'
        | 'pendente'
        | 'pago'
        | 'parcial'
        | 'expirado'
        | 'cancelado'
        | 'falha'
      >()
      .notNull()
      .default('criando'),
    /** Cobranca Pix da LuniumPay (trilho `pix`). */
    pixChargeId: uuid('pix_charge_id'),
    /** Pedido de swap (trilho `bitcoin`). */
    swapOrderId: uuid('swap_order_id'),
    /**
     * BR Code do trilho `pix_direto`.
     *
     * O motor nao descobre o pagamento sozinho (nao ha webhook do banco do
     * usuario): o pedido fica esperando ate a confirmacao.
     */
    pixDirect: jsonb('pix_direct').$type<
      | {
          br_code: string;
          key_masked: string;
          key_type: string | null;
          txid: string;
          amount: string;
        }
      | null
    >(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('payment_requests_client_external_uq').on(
      table.clientId,
      table.externalId,
    ),
    index('payment_requests_status_idx').on(table.status),
    index('payment_requests_created_idx').on(table.createdAt),
    check(
      'payment_requests_status_chk',
      sql`${table.status} in ('criando','pendente','pago','parcial','expirado','cancelado','falha')`,
    ),
    check(
      'payment_requests_currency_chk',
      sql`${table.currency} in ('BRL','USD')`,
    ),
    check(
      'payment_requests_amount_chk',
      sql`${table.amountFiatCents} > 0`,
    ),
  ],
);

/**
 * Desafio de prova de posse (C12).
 *
 * O motor emite o nonce, o app assina a mensagem com a chave EVM da carteira
 * e o motor confere a assinatura. O nonce e de uso unico e expira: e o que
 * impede que alguem registre um endereco que nao e dele.
 */
export const possessionChallenges = pgTable(
  'possession_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nonce: text('nonce').notNull(),
    address: text('address').notNull(),
    purpose: text('purpose')
      .$type<'client_registration' | 'wallet_registration'>()
      .notNull(),
    /** Mensagem exata que o app assinou (o motor reconfere byte a byte). */
    message: text('message').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('possession_challenges_nonce_uq').on(table.nonce),
    index('possession_challenges_address_idx').on(table.address),
    index('possession_challenges_expires_idx').on(table.expiresAt),
    check(
      'possession_challenges_purpose_chk',
      sql`${table.purpose} in ('client_registration','wallet_registration')`,
    ),
  ],
);

/**
 * Revogacao de endereco (C12.1).
 *
 * A loja cadastrou o endereco de um usuario como destino de liquidacao. O
 * dono do endereco revoga esse registro: e o controle que substitui a prova
 * da loja (C14) enquanto ela nao existe.
 */
export const addressRevocations = pgTable(
  'address_revocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    address: text('address').notNull(),
    merchantId: uuid('merchant_id').references(() => apiClients.id, {
      onDelete: 'cascade',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('address_revocations_address_merchant_uq').on(
      table.address,
      table.merchantId,
    ),
    index('address_revocations_address_idx').on(table.address),
  ],
);

/**
 * Flags do servico (F7).
 *
 * O rollback remoto nao pode depender de publicar nova versao do app: as flags
 * ficam no motor e o app le por HTTP.
 */
export const serviceFlags = pgTable('service_flags', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: updatedAt(),
});

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'restrict' }),
    conversionId: uuid('conversion_id').references(() => conversionOrders.id, {
      onDelete: 'set null',
    }),
    pixChargeId: uuid('pix_charge_id').references(() => pixCharges.id, {
      onDelete: 'set null',
    }),
    walletId: uuid('wallet_id').references(() => merchantWallets.id, {
      onDelete: 'restrict',
    }),
    asset: text('asset').$type<'USDC'>().notNull().default('USDC'),
    chain: text('chain').$type<'base' | 'polygon'>().notNull().default('base'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    feeMinor: bigint('fee_minor', { mode: 'bigint' }),
    status: text('status')
      .$type<
        | 'pendente'
        | 'aprovado'
        | 'enviando'
        | 'confirmado'
        | 'retido'
        | 'falhou'
        | 'cancelado'
      >()
      .notNull()
      .default('pendente'),
    txid: text('txid'),
    idempotencyKey: text('idempotency_key').notNull(),
    destinationAddress: text('destination_address'),
    approvedBy: text('approved_by'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('payouts_idempotency_uq').on(table.idempotencyKey),
    uniqueIndex('payouts_pix_charge_uq').on(table.pixChargeId),
    index('payouts_merchant_idx').on(table.merchantId),
    index('payouts_status_idx').on(table.status),
    check(
      'payouts_source_chk',
      sql`((${table.conversionId} is not null)::int + (${table.pixChargeId} is not null)::int) = 1`,
    ),
    check(
      'payouts_status_chk',
      sql`${table.status} in ('pendente','aprovado','enviando','confirmado','retido','falhou','cancelado')`,
    ),
    check(
      'payouts_asset_chk',
      sql`${table.asset} in ('USDC') and ${table.chain} in ('base','polygon')`,
    ),
    check('payouts_amount_chk', sql`${table.amountMinor} > 0`),
  ],
);

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id').references(() => apiClients.id, {
      onDelete: 'set null',
    }),
    code: text('code').notNull(),
    asset: text('asset').$type<'BTC' | 'BRL' | 'USD' | 'USDC'>().notNull(),
    kind: text('kind')
      .$type<'asset' | 'liability' | 'revenue' | 'expense' | 'equity'>()
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('ledger_accounts_code_asset_uq').on(
      table.code,
      table.asset,
    ),
    index('ledger_accounts_merchant_idx').on(table.merchantId),
    check(
      'ledger_accounts_asset_chk',
      sql`${table.asset} in ('BTC','BRL','USD','USDC')`,
    ),
    check(
      'ledger_accounts_kind_chk',
      sql`${table.kind} in ('asset','liability','revenue','expense','equity')`,
    ),
  ],
);

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    referenceType: text('reference_type').notNull(),
    referenceId: text('reference_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('ledger_transactions_ref_uq').on(
      table.kind,
      table.referenceType,
      table.referenceId,
    ),
    index('ledger_transactions_reference_idx').on(
      table.referenceType,
      table.referenceId,
    ),
    index('ledger_transactions_created_idx').on(table.createdAt),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    asset: text('asset').$type<'BTC' | 'BRL' | 'USD' | 'USDC'>().notNull(),
    debitMinor: bigint('debit_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    creditMinor: bigint('credit_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    createdAt: createdAt(),
  },
  (table) => [
    index('ledger_entries_transaction_idx').on(table.transactionId),
    index('ledger_entries_account_idx').on(table.accountId),
    check(
      'ledger_entries_asset_chk',
      sql`${table.asset} in ('BTC','BRL','USD','USDC')`,
    ),
    check(
      'ledger_entries_amount_chk',
      sql`${table.debitMinor} >= 0 and ${table.creditMinor} >= 0 and ((${table.debitMinor} > 0 and ${table.creditMinor} = 0) or (${table.creditMinor} > 0 and ${table.debitMinor} = 0))`,
    ),
  ],
);

export const treasuryWallets = pgTable(
  'treasury_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind')
      .$type<'btc_hot' | 'btc_cold' | 'usdc_hot' | 'gas_base'>()
      .notNull(),
    chain: text('chain').notNull(),
    network: text('network').notNull(),
    address: text('address').notNull(),
    xpub: text('xpub'),
    status: text('status').$type<'ativo' | 'inativo'>().notNull().default('ativo'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('treasury_wallets_chain_address_uq').on(
      table.chain,
      table.address,
    ),
    check(
      'treasury_wallets_kind_chk',
      sql`${table.kind} in ('btc_hot','btc_cold','usdc_hot','gas_base')`,
    ),
    check(
      'treasury_wallets_status_chk',
      sql`${table.status} in ('ativo','inativo')`,
    ),
  ],
);

export const providerEvents = pgTable(
  'provider_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    eventType: text('event_type').notNull(),
    externalId: text('external_id').notNull(),
    conversionId: uuid('conversion_id').references(() => conversionOrders.id, {
      onDelete: 'set null',
    }),
    pixChargeId: uuid('pix_charge_id').references(() => pixCharges.id, {
      onDelete: 'set null',
    }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('provider_events_external_uq').on(
      table.provider,
      table.externalId,
    ),
    index('provider_events_conversion_idx').on(table.conversionId),
    index('provider_events_pix_charge_idx').on(table.pixChargeId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: text('status')
      .$type<'pendente_email' | 'ativo' | 'bloqueado'>()
      .notNull()
      .default('pendente_email'),
    emailVerifiedAt: timestamp('email_verified_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('users_email_uq').on(table.email),
    check(
      'users_status_chk',
      sql`${table.status} in ('pendente_email','ativo','bloqueado')`,
    ),
  ],
);

export const merchantMembers = pgTable(
  'merchant_members',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    role: text('role')
      .$type<'owner' | 'admin' | 'member'>()
      .notNull()
      .default('owner'),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.merchantId] }),
    index('merchant_members_merchant_idx').on(table.merchantId),
    check(
      'merchant_members_role_chk',
      sql`${table.role} in ('owner','admin','member')`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    /** Navegador e IP do login, para a tela de sessoes do painel. */
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('email_verification_token_hash_uq').on(table.tokenHash),
    index('email_verification_token_user_idx').on(table.userId),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('password_reset_token_hash_uq').on(table.tokenHash),
    index('password_reset_token_user_idx').on(table.userId),
  ],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    amountSats: bigint('amount_sats', { mode: 'bigint' }).notNull(),
    description: text('description'),
    interval: text('interval').$type<'day' | 'week' | 'month'>().notNull(),
    status: text('status')
      .$type<'ativa' | 'pausada' | 'cancelada' | 'falha'>()
      .notNull()
      .default('ativa'),
    externalId: text('external_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    nextChargeAt: timestamp('next_charge_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('subscriptions_merchant_idx').on(table.merchantId),
    index('subscriptions_next_charge_idx').on(table.status, table.nextChargeAt),
    check(
      'subscriptions_interval_chk',
      sql`${table.interval} in ('day','week','month')`,
    ),
    check(
      'subscriptions_status_chk',
      sql`${table.status} in ('ativa','pausada','cancelada','falha')`,
    ),
  ],
);

export const subscriptionCharges = pgTable(
  'subscription_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    intentId: uuid('intent_id').references(() => paymentIntents.id, {
      onDelete: 'set null',
    }),
    periodStart: timestamp('period_start', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status')
      .$type<'criada' | 'paga' | 'falhou'>()
      .notNull()
      .default('criada'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    index('subscription_charges_sub_idx').on(table.subscriptionId),
    uniqueIndex('subscription_charges_intent_uq').on(table.intentId),
    check(
      'subscription_charges_status_chk',
      sql`${table.status} in ('criada','paga','falhou')`,
    ),
  ],
);

/**
 * Chave de loja virtual (plugins WooCommerce/Shopify): um header
 * `x-api-key`, sem assinar cada chamada. So cria e consulta faturas; com a
 * chave vazada, ninguem consegue mexer em carteira nem desviar dinheiro (a
 * fatura sempre paga a loja). `test` nunca chama provedor.
 */
export const storeKeys = pgTable(
  'store_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<'live' | 'test'>().notNull(),
    label: text('label'),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    /** Segredo que assina o IPN, cifrado (AAD = id da chave). */
    ipnSecretEnc: text('ipn_secret_enc').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('store_keys_hash_uq').on(table.keyHash),
    index('store_keys_client_idx').on(table.clientId),
    check('store_keys_mode_chk', sql`${table.mode} in ('live','test')`),
  ],
);

export type InvoiceStatus = 'aguardando' | 'confirmando' | 'pago' | 'expirado' | 'cancelado';

/**
 * Fatura hospedada (/i/:id). O Pix e o Bitcoin so sao criados quando o
 * pagador escolhe: o Pix precisa do CPF dele, e abrir a pagina nao abre
 * ordem em provedor nenhum.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    storeKeyId: uuid('store_key_id').references(() => storeKeys.id, { onDelete: 'set null' }),
    mode: text('mode').$type<'live' | 'test'>().notNull(),
    orderId: text('order_id').notNull(),
    amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
    currency: text('currency').$type<'BRL' | 'USD'>().notNull(),
    description: text('description'),
    customerEmail: text('customer_email'),
    successUrl: text('success_url'),
    cancelUrl: text('cancel_url'),
    ipnUrl: text('ipn_url'),
    rails: jsonb('rails').$type<Array<'pix' | 'bitcoin' | 'usdc' | 'pix_direto'>>().notNull(),
    status: text('status').$type<InvoiceStatus>().notNull().default('aguardando'),
    pixChargeId: uuid('pix_charge_id').references(() => pixCharges.id, { onDelete: 'set null' }),
    swapOrderId: uuid('swap_order_id').references(() => swapOrders.id, { onDelete: 'set null' }),
    /** Trilho escolhido no modo teste (nao ha cobranca real). */
    testRail: text('test_rail').$type<'pix' | 'bitcoin' | 'usdc' | 'pix_direto'>(),
    paidRail: text('paid_rail').$type<'pix' | 'bitcoin' | 'usdc' | 'pix_direto'>(),
    /**
     * Trilho USDC direto: o pagador manda USDC da carteira dele para a da
     * loja. O valor leva "centavos de centavo" unicos (ate 0,009999) para
     * apontar qual transferencia pagou qual fatura.
     */
    usdcAmountMinor: bigint('usdc_amount_minor', { mode: 'bigint' }),
    usdcAddress: text('usdc_address'),
    usdcStartBlock: bigint('usdc_start_block', { mode: 'bigint' }),
    /** Ultimo bloco ja varrido (a busca continua dali). */
    usdcScannedBlock: bigint('usdc_scanned_block', { mode: 'bigint' }),
    usdcTxHash: text('usdc_tx_hash'),
    usdcLogIndex: integer('usdc_log_index'),
    /** Pix direto: o txid da cobranca criada na API Pix do banco da loja. */
    pixDiretoTxid: text('pix_direto_txid'),
    pixDiretoCopypaste: text('pix_direto_copypaste'),
    txHash: text('tx_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('invoices_order_uq').on(table.clientId, table.mode, table.orderId),
    index('invoices_open_idx').on(table.status, table.updatedAt),
    index('invoices_client_created_idx').on(table.clientId, table.createdAt),
    // Uma transferencia prova uma fatura so.
    uniqueIndex('invoices_usdc_transfer_uq').on(table.usdcTxHash, table.usdcLogIndex),
    check('invoices_mode_chk', sql`${table.mode} in ('live','test')`),
    check(
      'invoices_status_chk',
      sql`${table.status} in ('aguardando','confirmando','pago','expirado','cancelado')`,
    ),
    check('invoices_currency_chk', sql`${table.currency} in ('BRL','USD')`),
  ],
);

/**
 * API Pix do banco da propria loja (conta PJ): com ela, o Pix da fatura cai
 * em reais na conta da loja e a confirmacao e automatica. Credenciais e
 * certificado cifrados (AAD = id da loja).
 */
export const merchantPixBanks = pgTable(
  'merchant_pix_banks',
  {
    clientId: uuid('client_id')
      .primaryKey()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    psp: text('psp').$type<'efi' | 'inter' | 'outro'>().notNull(),
    environment: text('environment').$type<'producao' | 'homologacao'>().notNull(),
    baseUrl: text('base_url'),
    tokenUrl: text('token_url'),
    oauthClientId: text('oauth_client_id').notNull(),
    oauthClientSecretEnc: text('oauth_client_secret_enc').notNull(),
    certificateEnc: text('certificate_enc').notNull(),
    certificatePassphraseEnc: text('certificate_passphrase_enc'),
    pixKey: text('pix_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true, mode: 'date' }),
    lastCheckError: text('last_check_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('merchant_pix_banks_psp_chk', sql`${table.psp} in ('efi','inter','outro')`),
    check('merchant_pix_banks_env_chk', sql`${table.environment} in ('producao','homologacao')`),
  ],
);
