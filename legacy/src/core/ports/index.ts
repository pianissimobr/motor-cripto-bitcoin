import type {
  ApiClient,
  ApiClientStatus,
  ApiClientWallet,
  AuditEvent,
  ChainAnchor,
  ChainCursor,
  InternalTransfer,
  LinkStatus,
  NaoRealizadoMotivo,
  ParamStyle,
  Payment,
  PaymentLink,
  RampProfile,
  TransferKind,
  TransferStatus,
  WebhookEvent,
  WebhookEventType,
} from '../domain/types.js';

/**
 * Ports do motor: contratos que o core usa para falar com a persistencia.
 * O core nao conhece Drizzle, SQL ou qualquer driver — apenas estas interfaces.
 */

/* ------------------------------------------------------------------ */
/* Clientes da API                                                     */
/* ------------------------------------------------------------------ */

export type CreateApiClientInput = {
  id: string;
  nome: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
  webhookUrl: string;
  webhookSecret: string;
  requestSecret: string;
};

export type UpdateApiClientInput = {
  nome?: string;
  webhookUrl?: string;
  status?: ApiClientStatus;
};

export interface ApiClientRepository {
  create(input: CreateApiClientInput): Promise<ApiClient>;
  findById(id: string): Promise<ApiClient | null>;
  findByApiKeyHash(apiKeyHash: string): Promise<ApiClient | null>;
  list(): Promise<ApiClient[]>;
  update(id: string, input: UpdateApiClientInput): Promise<ApiClient | null>;
  rotateKey(
    id: string,
    apiKeyHash: string,
    apiKeyPrefix: string,
    requestSecret: string,
  ): Promise<ApiClient | null>;
  rotateWebhookSecret(id: string, webhookSecret: string): Promise<ApiClient | null>;
}

export type CreateApiClientWalletInput = {
  apiClienteId: string;
  label: string;
  chain: string;
  address: string;
};

export interface ApiClientWalletRepository {
  create(input: CreateApiClientWalletInput): Promise<ApiClientWallet>;
  findById(id: string): Promise<ApiClientWallet | null>;
  findByClientAndAddress(
    apiClienteId: string,
    address: string,
  ): Promise<ApiClientWallet | null>;
  listByClient(apiClienteId: string): Promise<ApiClientWallet[]>;
  listAll(): Promise<ApiClientWallet[]>;
}

/** Nonces de HMAC: um nonce so pode ser usado uma vez por cliente. */
export interface NonceRepository {
  /** true = nonce novo; false = replay (ja existia). */
  use(apiClienteId: string, nonce: string, expiresAt: Date): Promise<boolean>;
  cleanup(now: Date): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Ramp profiles                                                       */
/* ------------------------------------------------------------------ */

export type CreateRampProfileInput = {
  label: string;
  chain: string;
  asset: string;
  tokenContract: string;
  decimals: number;
  fiatCurrency: string;
  baseUrl: string;
  paramStyle: ParamStyle;
  hostAppName: string;
  hostLogoUrl?: string | null;
  hostApiKey?: string | null;
  rampAssetKey?: string | null;
  taxaTokenPorFiatBaseUnits: bigint | null;
};

/** Campos mutaveis de um perfil. Chain/asset/contrato/decimais sao imutaveis. */
export type UpdateRampProfileInput = Partial<
  Omit<CreateRampProfileInput, 'chain' | 'asset' | 'tokenContract' | 'decimals'>
>;

export interface RampProfileRepository {
  create(input: CreateRampProfileInput): Promise<RampProfile>;
  /** Atualiza apenas os campos presentes. `null` limpa o campo. */
  update(id: string, input: UpdateRampProfileInput): Promise<RampProfile | null>;
  findById(id: string): Promise<RampProfile | null>;
  list(): Promise<RampProfile[]>;
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

export type CreateLinkInput = {
  id: string;
  apiClienteId: string;
  externalId: string;
  idempotencyKey: string;
  requestHash: string;
  rampProfileId: string;
  chain: string;
  asset: string;
  tokenContract: string;
  decimals: number;
  moedaFiat: string;
  valorFiatCentavos: number;
  valorFiatUnidades: number;
  taxaTokenPorFiatBaseUnits: bigint | null;
  expectedBaseUnits: bigint | null;
  indiceHd: number;
  caminhoDerivacao: string;
  enderecoDeposito: string;
  walletAddress: string;
  pageToken: string;
  pageTokenHash: string;
  rampUrl: string;
  status: LinkStatus;
  expiraEm: Date;
  liquidacaoAte: Date;
};

export type SettlementPatch = {
  motivoNaoRealizado?: NaoRealizadoMotivo | null;
  valorRecebidoBaseUnits?: bigint;
  reembolsado?: boolean;
};

export interface LinkRepository {
  create(input: CreateLinkInput): Promise<PaymentLink>;
  findById(id: string): Promise<PaymentLink | null>;
  findByDepositAddress(address: string): Promise<PaymentLink | null>;
  findByPageTokenHash(hash: string): Promise<PaymentLink | null>;
  findByExternalId(apiClienteId: string, externalId: string): Promise<PaymentLink | null>;
  findByIdempotencyKey(
    apiClienteId: string,
    idempotencyKey: string,
  ): Promise<PaymentLink | null>;
  listByClient(apiClienteId: string, limit: number): Promise<PaymentLink[]>;
  listAll(limit: number): Promise<PaymentLink[]>;
  listByStatus(status: LinkStatus, limit: number): Promise<PaymentLink[]>;
  /** Links com pagina vencida que ainda estao 'aguardando'. */
  listExpiredPages(now: Date, limit: number): Promise<PaymentLink[]>;
  /** Links em janela de liquidacao vencida. */
  listDueSettlement(now: Date, limit: number): Promise<PaymentLink[]>;
  updateStatus(id: string, status: LinkStatus): Promise<void>;
  updateSettlement(id: string, patch: SettlementPatch): Promise<void>;
  /** Enderecos de deposito por status, para o filtro de topics do monitor. */
  listDepositAddresses(statuses: LinkStatus[]): Promise<string[]>;
  /** Pares (chain, contrato) ainda presentes em links nesses status. */
  listTokenPairs(statuses: LinkStatus[]): Promise<Array<{ chain: string; tokenContract: string }>>;
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export type UpsertPaymentInput = {
  linkId: string;
  txHash: string;
  logIndex: number;
  deAddress: string;
  paraAddress: string;
  token: string;
  valorBaseUnits: bigint;
  bloco: number;
  status: Payment['status'];
  detectadoEm: Date;
};

export interface PaymentRepository {
  /** Idempotente por (tx_hash, log_index). */
  upsert(input: UpsertPaymentInput): Promise<Payment>;
  confirm(input: { paymentId: string; confirmacoes: number }): Promise<Payment>;
  findByTxHash(txHash: string): Promise<Payment | null>;
  listByLink(linkId: string): Promise<Payment[]>;
  listByStatus(status: Payment['status'], limit: number): Promise<Payment[]>;
  /** Confirmados cujo link ainda nao chegou a um estado final. */
  listForReconciliation(limit: number): Promise<Payment[]>;
  sumConfirmedByLink(linkId: string): Promise<bigint>;
  updateConfirmations(paymentId: string, confirmacoes: number): Promise<void>;
  /**
   * C4: reverte todos os pagamentos acima de `bloco` na chain informada.
   * Usado quando o cursor e rewindado por reorg.
   */
  revertAboveBlock(chain: string, bloco: number): Promise<number>;
  /** Pagamentos confirmados cujo bloco caiu no reorg (fila de revogacao). */
  listConfirmedAboveBlock(chain: string, bloco: number): Promise<Payment[]>;
}

/* ------------------------------------------------------------------ */
/* Internal transfers (sweeps)                                         */
/* ------------------------------------------------------------------ */

export type CreateTransferInput = {
  linkId: string;
  deAddress: string;
  paraAddress: string;
  valorBaseUnits: bigint;
  status: TransferStatus;
  txHash?: string | null;
  erro?: string | null;
  chain: string;
  bloco?: number | null;
  /**
   * D4: nonce do endereco derivado. Um mesmo link nunca pode ter dois
   * sweeps com o mesmo nonce (seriam a mesma transacao logica).
   */
  nonce?: number | null;
  kind?: TransferKind;
  rawTransaction?: string | null;
  unsignedTransaction?: string | null;
};

export interface TransferRepository {
  create(input: CreateTransferInput): Promise<InternalTransfer>;
  update(
    id: string,
    patch: Partial<
      Pick<
        InternalTransfer,
        | 'status'
        | 'txHash'
        | 'erro'
        | 'valorBaseUnits'
        | 'paraAddress'
        | 'bloco'
        | 'rawTransaction'
        | 'unsignedTransaction'
      >
    >,
  ): Promise<void>;
  findById(id: string): Promise<InternalTransfer | null>;
  findByLink(linkId: string): Promise<InternalTransfer[]>;
  listByStatus(status: TransferStatus, limit: number): Promise<InternalTransfer[]>;
  /** C5: marca como 'pendente' os sweeps cujo bloco caiu no reorg. */
  revertAboveBlock(chain: string, bloco: number): Promise<number>;
  /** D4: ja existe um movimento registrado para este (link, nonce)? */
  existsByNonce(linkId: string, nonce: number): Promise<boolean>;
  /** Idempotencia real: (link, tipo, nonce). */
  findByLinkKindNonce(
    linkId: string,
    kind: TransferKind,
    nonce: number,
  ): Promise<InternalTransfer | null>;
  /** Movimentos transmitidos/em assinatura que precisam ser retomados. */
  listInFlight(limit: number): Promise<InternalTransfer[]>;
}

/* ------------------------------------------------------------------ */
/* Webhook outbox                                                      */
/* ------------------------------------------------------------------ */

export type CreateWebhookEventInput = {
  apiClienteId: string;
  linkId: string;
  eventType: WebhookEventType;
  payload: string;
  nextAttemptEm: Date;
};

export interface WebhookOutboxRepository {
  /** null quando ja existe evento do mesmo tipo para o link. */
  enqueue(input: CreateWebhookEventInput): Promise<WebhookEvent | null>;
  findById(id: string): Promise<WebhookEvent | null>;
  listDue(now: Date, limit: number): Promise<WebhookEvent[]>;
  listByLink(linkId: string): Promise<WebhookEvent[]>;
  listAll(limit: number): Promise<WebhookEvent[]>;
  markDelivered(id: string): Promise<void>;
  markFailed(
    id: string,
    input: {
      attempts: number;
      nextAttemptEm: Date;
      lastError: string;
      status?: 'pendente' | 'falhou';
    },
  ): Promise<void>;
  /** Recoloca um evento na fila (admin replay). */
  replay(id: string, now: Date): Promise<WebhookEvent | null>;
}

/* ------------------------------------------------------------------ */
/* Cursors / anchors / HD index / audit                                */
/* ------------------------------------------------------------------ */

export interface CursorRepository {
  get(chain: string, tokenContract: string): Promise<ChainCursor | null>;
  set(chain: string, tokenContract: string, bloco: number, hashBloco: string | null): Promise<void>;
  /** Move o cursor para tras (reorg). */
  rewind(chain: string, tokenContract: string, bloco: number, hashBloco: string | null): Promise<void>;
}

/** C2: ancoras esparsas de hash de bloco para detectar e resolver reorg. */
export interface AnchorRepository {
  record(anchor: ChainAnchor): Promise<void>;
  /** Ancoras do par (chain, token), da mais nova para a mais antiga. */
  list(chain: string, tokenContract: string, limit: number): Promise<ChainAnchor[]>;
  /** Remove ancoras acima de `bloco` (invalidadas pelo reorg). */
  pruneAfter(chain: string, tokenContract: string, bloco: number): Promise<void>;
  /** A ancora mais antiga ainda guardada (limite da retrospectiva). */
  oldest(chain: string, tokenContract: string): Promise<ChainAnchor | null>;
}

/**
 * Alocacao atomica do indice HD. Nao pode devolver o mesmo indice duas
 * vezes (endereco derivado e publico: reutilizar expoe fundos antigos).
 */
export interface IndexAllocator {
  /** Aloca o proximo indice global. `maxIndex` e o maior indice permitido. */
  allocate(scope: string, maxIndex?: number): Promise<number>;
  /**
   * Libera uma reserva que ainda nao foi ligada a um link (rollback da
   * criacao). Nunca apaga um indice ja usado por link.
   */
  release(scope: string, indice: number): Promise<void>;
}

export type RecordAuditInput = {
  ator: string;
  acao: string;
  entidade: string;
  entidadeId?: string | null;
  detalhes?: Record<string, unknown> | null;
  ip?: string | null;
};

export interface AuditRepository {
  record(input: RecordAuditInput): Promise<void>;
  list(limit: number): Promise<AuditEvent[]>;
}

/** Repositorio agregado, entregue ao core como unico objeto. */
export type MotorRepositories = {
  apiClients: ApiClientRepository;
  apiClientWallets: ApiClientWalletRepository;
  nonces: NonceRepository;
  rampProfiles: RampProfileRepository;
  links: LinkRepository;
  payments: PaymentRepository;
  transfers: TransferRepository;
  webhooks: WebhookOutboxRepository;
  cursors: CursorRepository;
  anchors: AnchorRepository;
  indices: IndexAllocator;
  audit: AuditRepository;
};
