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
 * Schema do motor.
 *
 * Regras:
 *  - dinheiro fiat em centavos (integer); token em base units (bigint)
 *  - PII cifrada em bytea + blind index (char 64) para busca
 *  - endereco de deposito e tx_hash com indice unico (idempotencia)
 */

export const cadastros = pgTable(
  'cadastros',
  {
    id: uuid('id').primaryKey(),
    nomeEnc: text('nome_enc').notNull(),
    emailEnc: text('email_enc').notNull(),
    emailBidx: text('email_bidx').notNull(),
    /**
     * Bloco 4: token do indice anterior durante a rotacao. O indice ATIVO
     * fica sempre em `email_bidx` (canonico e unico); a busca consulta as
     * duas colunas enquanto a chave antiga existir.
     */
    emailBidxAnterior: text('email_bidx_anterior'),
    nomeMasked: text('nome_masked').notNull(),
    emailMasked: text('email_masked').notNull(),
    status: text('status').notNull().default('ativo'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cadastros_email_bidx_uq').on(t.emailBidx),
    index('cadastros_email_bidx_anterior_idx').on(t.emailBidxAnterior),
    index('cadastros_criado_em_idx').on(t.criadoEm),
  ],
);

export const cadastrosPrefixos = pgTable(
  'cadastros_prefixos',
  {
    prefixBidx: text('prefix_bidx').notNull(),
    /**
     * E3: token v2 cru (o token tambem vai em `prefix_bidx` com o prefixo
     * literal "v2:"). Mantido para diagnostico; a busca usa `prefix_bidx`.
     */
    prefixBidxV2: text('prefix_bidx_v2'),
    clienteId: uuid('cliente_id')
      .notNull()
      .references(() => cadastros.id, { onDelete: 'cascade' }),
  },
  (t) => [
    // Bloco 4: o token so e unico DENTRO do cliente. Antes o PK era apenas
    // o token e dois clientes com o mesmo prefixo colidiam entre si.
    primaryKey({
      name: 'cadastros_prefixos_cliente_prefix_pk',
      columns: [t.clienteId, t.prefixBidx],
    }),
    index('cadastros_prefixos_prefix_idx').on(t.prefixBidx),
    index('cadastros_prefixos_cliente_idx').on(t.clienteId),
    index('cadastros_prefixos_v2_idx').on(t.prefixBidxV2),
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

export const carteirasFrias = pgTable(
  'carteiras_frias',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    address: text('address').notNull(),
    chain: text('chain').notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('carteiras_frias_address_uq').on(t.address),
    uniqueIndex('carteiras_frias_label_uq').on(t.label),
  ],
);

export const linksGerados = pgTable(
  'links_gerados',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clienteId: uuid('cliente_id')
      .notNull()
      .references(() => cadastros.id, { onDelete: 'cascade' }),
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
    rampUrl: text('ramp_url').notNull(),
    /**
     * A1: destino do sweep persistido no momento da criacao do link.
     * Antes o sweeper resolvia sozinho e ignorava a escolha do operador.
     * Nullable para preservar links legados criados antes da correcao.
     */
    carteiraFriaId: uuid('carteira_fria_id').references(() => carteirasFrias.id, {
      onDelete: 'set null',
    }),
    carteiraFriaEndereco: text('carteira_fria_endereco'),
    status: text('status').notNull().default('aguardando'),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('links_gerados_endereco_uq').on(t.enderecoDeposito),
    uniqueIndex('links_gerados_indice_hd_uq').on(t.indiceHd),
    index('links_gerados_cliente_idx').on(t.clienteId),
    index('links_gerados_status_idx').on(t.status),
    index('links_gerados_criado_em_idx').on(t.criadoEm),
  ],
);

export const cadastrosLinks = pgTable(
  'cadastros_links',
  {
    clienteId: uuid('cliente_id')
      .notNull()
      .references(() => cadastros.id, { onDelete: 'cascade' }),
    linkId: uuid('link_id')
      .notNull()
      .references(() => linksGerados.id, { onDelete: 'cascade' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.clienteId, t.linkId] })],
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

export const creditosCliente = pgTable(
  'creditos_cliente',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clienteId: uuid('cliente_id')
      .notNull()
      .references(() => cadastros.id, { onDelete: 'cascade' }),
    linkId: uuid('link_id')
      .notNull()
      .references(() => linksGerados.id, { onDelete: 'cascade' }),
    pagamentoId: uuid('pagamento_id')
      .notNull()
      .references(() => linksPagos.id, { onDelete: 'cascade' }),
    valorBaseUnits: bigint('valor_base_units', { mode: 'bigint' }).notNull(),
    valorCentavos: bigint('valor_centavos', { mode: 'bigint' }),
    moeda: text('moeda').notNull(),
    status: text('status').notNull().default('pendente'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('creditos_cliente_pagamento_uq').on(t.pagamentoId),
    index('creditos_cliente_cliente_idx').on(t.clienteId),
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
    /** C5: chain e bloco do sweep, para detectar se ele caiu num reorg. */
    chain: text('chain').notNull().default('polygon'),
    bloco: integer('bloco'),
    /** D4: nonce do endereco derivado; garante um sweep por nonce. */
    nonce: integer('nonce'),
    /** Separa sweep do token, dust nativo e recuperacao sintetica. */
    kind: text('kind').notNull().default('sweep'),
    /** Raw assinada persistida antes do broadcast (recuperacao pos-crash). */
    rawTransaction: text('raw_transaction'),
    /** JSON da transacao unsigned no modo PSBT. */
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
