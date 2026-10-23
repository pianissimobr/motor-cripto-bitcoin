import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Schema do motor API-only.
 *
 * Regras:
 *  - dinheiro fiat em centavos (integer); token em base units (bigint)
 *  - segredos (webhook secret, page token) cifrados em repouso
 *  - endereco de deposito, indice HD, external_id e page token unicos
 */

export const apiClientes = pgTable(
  'api_clientes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nome: text('nome').notNull(),
    /** SHA-256 hex da API key. A chave em claro so existe na criacao. */
    apiKeyHash: text('api_key_hash').notNull(),
    /** Prefixo publico para exibir no admin (ex.: mk_live_ab12). */
    apiKeyPrefix: text('api_key_prefix').notNull(),
    webhookUrl: text('webhook_url').notNull(),
    /** Segredo HMAC dos webhooks, cifrado com o id do cliente como AAD. */
    webhookSecretEnc: text('webhook_secret_enc').notNull(),
    /** Segredo HMAC das requisicoes da API, cifrado com o id do cliente. */
    requestSecretEnc: text('request_secret_enc').notNull(),
    status: text('status').notNull().default('ativo'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_clientes_api_key_hash_uq').on(t.apiKeyHash),
    index('api_clientes_status_idx').on(t.status),
  ],
);

export const apiClienteWallets = pgTable(
  'api_cliente_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiClienteId: uuid('api_cliente_id')
      .notNull()
      .references(() => apiClientes.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_cliente_wallets_cliente_chain_address_uq').on(
      t.apiClienteId,
      t.chain,
      t.address,
    ),
    index('api_cliente_wallets_cliente_idx').on(t.apiClienteId),
  ],
);

/** Nonces de HMAC. Um nonce so vale uma vez por cliente. */
export const apiNonces = pgTable(
  'api_nonces',
  {
    apiClienteId: uuid('api_cliente_id')
      .notNull()
      .references(() => apiClientes.id, { onDelete: 'cascade' }),
    nonce: text('nonce').notNull(),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.apiClienteId, t.nonce] }),
    index('api_nonces_expira_em_idx').on(t.expiraEm),
  ],
);

export const rampProfiles = pgTable(
  'ramp_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    chain: text('chain').notNull(),
    asset: text('asset').notNull(),
    tokenContract: text('token_contract').notNull(),
    decimals: integer('decimals').notNull().default(6),
    fiatCurrency: text('fiat_currency').notNull().default('BRL'),
    baseUrl: text('base_url').notNull(),
    paramStyle: text('param_style').notNull().default('legacy'),
    hostAppName: text('host_app_name').notNull().default('Motor Cripto'),
    hostLogoUrl: text('host_logo_url'),
    hostApiKeyEnc: text('host_api_key_enc'),
    rampAssetKey: text('ramp_asset_key'),
    /** base units do token por 1,00 unidade de fiat (ex.: 180000 = 0,18 USDC/BRL) */
    taxaTokenPorFiatBaseUnits: bigint('taxa_token_por_fiat_base_units', { mode: 'bigint' }),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ramp_profiles_label_uq').on(t.label)],
);

export const linksGerados = pgTable(
  'links_gerados',
  {
    id: uuid('id').primaryKey(),
    apiClienteId: uuid('api_cliente_id')
      .notNull()
      .references(() => apiClientes.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    rampProfileId: uuid('ramp_profile_id')
      .notNull()
      .references(() => rampProfiles.id, { onDelete: 'restrict' }),
    chain: text('chain').notNull(),
    asset: text('asset').notNull(),
    tokenContract: text('token_contract').notNull(),
    decimals: integer('decimals').notNull().default(6),
    moedaFiat: text('moeda_fiat').notNull(),
    valorFiatCentavos: integer('valor_fiat_centavos').notNull(),
    valorFiatUnidades: integer('valor_fiat_unidades').notNull(),
    taxaTokenPorFiatBaseUnits: bigint('taxa_token_por_fiat_base_units', { mode: 'bigint' }),
    expectedBaseUnits: bigint('expected_base_units', { mode: 'bigint' }),
    indiceHd: integer('indice_hd').notNull(),
    caminhoDerivacao: text('caminho_derivacao').notNull(),
    enderecoDeposito: text('endereco_deposito').notNull(),
    /** Destino do sweep: carteira allowlisted do cliente. */
    walletAddress: text('wallet_address').notNull(),
    pageTokenHash: text('page_token_hash').notNull(),
    /** Token da pagina cifrado (AAD = id do link). */
    pageTokenEnc: text('page_token_enc').notNull(),
    rampUrl: text('ramp_url').notNull(),
    status: text('status').notNull().default('aguardando'),
    motivoNaoRealizado: text('motivo_nao_realizado'),
    valorRecebidoBaseUnits: bigint('valor_recebido_base_units', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    reembolsado: boolean('reembolsado').notNull().default(false),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
    liquidacaoAte: timestamp('liquidacao_ate', { withTimezone: true }).notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('links_gerados_endereco_uq').on(t.enderecoDeposito),
    uniqueIndex('links_gerados_indice_hd_uq').on(t.indiceHd),
    uniqueIndex('links_gerados_page_token_uq').on(t.pageTokenHash),
    uniqueIndex('links_gerados_cliente_external_uq').on(t.apiClienteId, t.externalId),
    uniqueIndex('links_gerados_cliente_idem_uq').on(t.apiClienteId, t.idempotencyKey),
    index('links_gerados_cliente_idx').on(t.apiClienteId),
    index('links_gerados_status_idx').on(t.status),
    index('links_gerados_expira_em_idx').on(t.expiraEm),
    index('links_gerados_liquidacao_ate_idx').on(t.liquidacaoAte),
    index('links_gerados_criado_em_idx').on(t.criadoEm),
  ],
);

export const linksPagos = pgTable(
  'links_pagos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => linksGerados.id, { onDelete: 'cascade' }),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    deAddress: text('de_address').notNull(),
    paraAddress: text('para_address').notNull(),
    token: text('token').notNull(),
    valorBaseUnits: bigint('valor_base_units', { mode: 'bigint' }).notNull(),
    confirmacoes: integer('confirmacoes').notNull().default(0),
    bloco: integer('bloco').notNull(),
    status: text('status').notNull().default('detectado'),
    detectadoEm: timestamp('detectado_em', { withTimezone: true }).notNull().defaultNow(),
    confirmadoEm: timestamp('confirmado_em', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('links_pagos_tx_log_uq').on(t.txHash, t.logIndex),
    index('links_pagos_link_idx').on(t.linkId),
    index('links_pagos_status_idx').on(t.status),
  ],
);

export const movimentosInternos = pgTable(
  'movimentos_internos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => linksGerados.id, { onDelete: 'cascade' }),
    deAddress: text('de_address').notNull(),
    paraAddress: text('para_address').notNull().default(''),
    valorBaseUnits: bigint('valor_base_units', { mode: 'bigint' }).notNull(),
    txHash: text('tx_hash'),
    status: text('status').notNull().default('pendente'),
    erro: text('erro'),
    chain: text('chain').notNull().default('polygon'),
    bloco: integer('bloco'),
    nonce: integer('nonce'),
    kind: text('kind').notNull().default('sweep'),
    rawTransaction: text('raw_transaction'),
    unsignedTransaction: text('unsigned_transaction'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('movimentos_internos_link_idx').on(t.linkId),
    index('movimentos_internos_status_idx').on(t.status),
    index('movimentos_internos_bloco_idx').on(t.chain, t.bloco),
    uniqueIndex('movimentos_internos_link_kind_nonce_uq').on(t.linkId, t.kind, t.nonce),
  ],
);

export const webhookOutbox = pgTable(
  'webhook_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiClienteId: uuid('api_cliente_id')
      .notNull()
      .references(() => apiClientes.id, { onDelete: 'cascade' }),
    linkId: uuid('link_id')
      .notNull()
      .references(() => linksGerados.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: text('payload').notNull(),
    status: text('status').notNull().default('pendente'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptEm: timestamp('next_attempt_em', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    deliveredEm: timestamp('delivered_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('webhook_outbox_link_event_uq').on(t.linkId, t.eventType),
    index('webhook_outbox_due_idx').on(t.status, t.nextAttemptEm),
    index('webhook_outbox_link_idx').on(t.linkId),
  ],
);

/**
 * C2: ancoras esparsas de hash de bloco.
 *
 * Se o hash em `chain_cursors` divergir do que a chain devolve, houve
 * reorg. Guardamos hashes a cada N blocos para poder voltar atras e
 * achar o ancestral comum sem refazer a varredura inteira.
 */
export const chainAnchors = pgTable(
  'chain_anchors',
  {
    chain: text('chain').notNull(),
    tokenContract: text('token_contract').notNull(),
    bloco: integer('bloco').notNull(),
    hashBloco: text('hash_bloco').notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chain, t.tokenContract, t.bloco] }),
    index('chain_anchors_lookup_idx').on(t.chain, t.tokenContract, t.bloco),
  ],
);

export const chainCursors = pgTable(
  'chain_cursors',
  {
    chain: text('chain').notNull(),
    tokenContract: text('token_contract').notNull(),
    ultimoBloco: integer('ultimo_bloco').notNull().default(0),
    hashBloco: text('hash_bloco'),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chain, t.tokenContract] })],
);

export const hdIndices = pgTable(
  'hd_indices',
  {
    scope: text('scope').notNull(),
    indice: integer('indice').notNull(),
    linkId: uuid('link_id').references(() => linksGerados.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.indice] }),
    uniqueIndex('hd_indices_link_uq').on(t.linkId),
    uniqueIndex('hd_indices_indice_uq').on(t.indice),
  ],
);

export const eventosAuditoria = pgTable(
  'eventos_auditoria',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ator: text('ator').notNull(),
    acao: text('acao').notNull(),
    entidade: text('entidade').notNull(),
    entidadeId: text('entidade_id'),
    detalhes: text('detalhes'),
    ip: text('ip'),
    hashAnterior: text('hash_anterior'),
    hash: text('hash'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('eventos_auditoria_criado_em_idx').on(t.criadoEm),
    index('eventos_auditoria_entidade_idx').on(t.entidade, t.entidadeId),
  ],
);
