import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ClientStatus,
  LightningPaymentStatus,
  OnchainPaymentStatus,
  PaidRail,
  PaymentIntentStatus,
  SweepStatus,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('api_clients_key_hash_uq').on(table.apiKeyHash),
    index('api_clients_prefix_idx').on(table.apiKeyPrefix),
    check(
      'api_clients_status_chk',
      sql`${table.status} in ('ativo', 'inativo')`,
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
    intentId: uuid('intent_id'),
    status: text('status')
      .$type<'alocada' | 'usada' | 'abandonada' | 'sweepada'>()
      .notNull()
      .default('alocada'),
    createdAt: createdAt(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('hd_addresses_index_uq').on(table.index),
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
    lightningInvoice: text('lightning_invoice'),
    lightningExpiresAt: timestamp('lightning_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    onchainAddressId: uuid('onchain_address_id').references(
      () => hdAddresses.id,
      { onDelete: 'set null' },
    ),
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
    check(
      'payment_intents_status_chk',
      sql`${table.status} in ('criando','pendente','pago','parcial','expirado','pago_tardio','cancelado','reorg','falha_criacao')`,
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
    intentId: uuid('intent_id')
      .notNull()
      .references(() => paymentIntents.id, { onDelete: 'cascade' }),
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
