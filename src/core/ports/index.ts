import type {
  AuditEvent,
  ChainAnchor,
  ChainCursor,
  ColdWallet,
  CreditStatus,
  CustomerCredit,
  CustomerStatus,
  InternalTransfer,
  LinkStatus,
  ParamStyle,
  Payment,
  PaymentLink,
  RampProfile,
  TransferKind,
  TransferStatus,
} from '../domain/types.js';

/**
 * Ports do motor: contratos que o core usa para falar com a persistencia.
 * O core nao conhece Drizzle, SQL ou qualquer driver — apenas estas interfaces.
 * Qualquer app que quiser reutilizar o motor implementa estes ports.
 */

/**
 * Entrada de criacao de cliente: **apenas** material cifrado e o blind index.
 * O texto puro nunca chega na camada de persistencia.
 */
export type CreateCustomerInput = {
  id: string;
  nomeEnc: Buffer;
  emailEnc: Buffer;
  /** Indice ATIVO do e-mail (canonico e unico entre clientes). */
  emailBidx: string;
  /** Indice anterior, mantido durante a rotacao para a busca continuar valendo. */
  emailBidxAnterior: string | null;
  nomeMasked: string;
  emailMasked: string;
  status?: CustomerStatus;
  /** Blind indexes dos prefixos do email (3..N chars) para busca parcial. */
  prefixBidxList: string[];
  /** E3: prefixos na versao 2. */
  prefixBidxListV2: string[];
};

/**
 * Cliente como esta armazenado (cifrado).
 * `emailBidx` = versao ativa do indice; `emailBidxAnterior` = a versao
 * antiga, mantida durante a rotacao para a busca continuar funcionando.
 */
export type StoredCustomer = {
  id: string;
  nomeEnc: Buffer;
  emailEnc: Buffer;
  emailBidx: string;
  emailBidxAnterior: string | null;
  nomeMasked: string;
  emailMasked: string;
  status: CustomerStatus;
  criadoEm: Date;
};

export interface CustomerRepository {
  create(input: CreateCustomerInput): Promise<StoredCustomer>;
  findById(id: string): Promise<StoredCustomer | null>;
  /** E3: busca exata em qualquer versao do indice ativo. */
  findByEmailBidx(emailBidxes: string[]): Promise<StoredCustomer | null>;
  /** E3: busca por prefixo em qualquer versao do indice ativo. */
  searchByEmailPrefixBidx(prefixBidxes: string[], limit: number): Promise<StoredCustomer[]>;
  list(limit: number, offset: number): Promise<StoredCustomer[]>;
  count(): Promise<number>;
  /** E4: linhas paginadas para a re-cifragem em lote. */
  listAllForRotation(afterId: string | null, limit: number): Promise<StoredCustomer[]>;
  /** E4: grava os blobs cifrados novamente. */
  updateEncrypted(
    id: string,
    nomeEnc: Buffer,
    emailEnc: Buffer,
    emailBidx: string,
    emailBidxAnterior: string | null,
    prefixBidxList: string[],
    prefixBidxListV2: string[],
  ): Promise<void>;
  /** Bloco 4: reconstroi os prefixos de um cliente (reindexacao). */
  replacePrefixes(
    id: string,
    prefixBidxList: string[],
    prefixBidxListV2: string[],
  ): Promise<void>;
}

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

export type CreateColdWalletInput = {
  label: string;
  address: string;
  chain: string;
};

export interface ColdWalletRepository {
  create(input: CreateColdWalletInput): Promise<ColdWallet>;
  findById(id: string): Promise<ColdWallet | null>;
  findByAddress(address: string): Promise<ColdWallet | null>;
  list(): Promise<ColdWallet[]>;
}

export type CreateLinkInput = {
  clienteId: string;
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
  carteiraFriaId: string | null;
  carteiraFriaEndereco: string;
  rampUrl: string;
  status: LinkStatus;
  expiraEm: Date;
};

export interface LinkRepository {
  create(input: CreateLinkInput): Promise<PaymentLink>;
  findById(id: string): Promise<PaymentLink | null>;
  findByDepositAddress(address: string): Promise<PaymentLink | null>;
  listByCustomer(clienteId: string): Promise<PaymentLink[]>;
  listAll(limit: number): Promise<PaymentLink[]>;
  listByStatus(status: LinkStatus, limit: number): Promise<PaymentLink[]>;
  updateStatus(id: string, status: LinkStatus): Promise<void>;
  /** Enderecos de deposito por status, para montar o filtro de topics do monitor. */
  listDepositAddresses(statuses: LinkStatus[]): Promise<string[]>;
}

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
  /** Confirma o pagamento e cria o credito atomicamente. */
  confirm(input: {
    paymentId: string;
    confirmacoes: number;
    credit: CreateCreditInput | null;
  }): Promise<{ payment: Payment; creditCreated: boolean }>;
  findByTxHash(txHash: string): Promise<Payment | null>;
  listByLink(linkId: string): Promise<Payment[]>;
  listByStatus(status: Payment['status'], limit: number): Promise<Payment[]>;
  /** Confirmados sem credito ou cujo link ficou com status defasado. */
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

export type CreateCreditInput = {
  clienteId: string;
  linkId: string;
  pagamentoId: string;
  valorBaseUnits: bigint;
  valorCentavos: number | null;
  moeda: string;
  status: CreditStatus;
};

export interface CreditRepository {
  create(input: CreateCreditInput): Promise<CustomerCredit>;
  listByCustomer(clienteId: string): Promise<CustomerCredit[]>;
  listByLink(linkId: string): Promise<CustomerCredit[]>;
  listAll(limit: number): Promise<CustomerCredit[]>;
  sumByCustomer(clienteId: string): Promise<number>;
  findByPayment(pagamentoId: string): Promise<CustomerCredit | null>;
  /** C4: reverte os creditos ligados a pagamentos revogados. */
  revertByPaymentIds(pagamentoIds: string[]): Promise<number>;
  /** Reorg revertido: reativa um credito que havia sido revogado. */
  restoreByPaymentIds(pagamentoIds: string[], status: CreditStatus): Promise<number>;
}

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
  customers: CustomerRepository;
  rampProfiles: RampProfileRepository;
  coldWallets: ColdWalletRepository;
  links: LinkRepository;
  payments: PaymentRepository;
  credits: CreditRepository;
  transfers: TransferRepository;
  cursors: CursorRepository;
  anchors: AnchorRepository;
  indices: IndexAllocator;
  audit: AuditRepository;
};
