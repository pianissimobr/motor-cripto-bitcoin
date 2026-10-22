import type {
  AuditEvent,
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
  emailBidx: string;
  nomeMasked: string;
  emailMasked: string;
  status?: CustomerStatus;
  /** Blind indexes dos prefixos do email (3..N chars) para busca parcial. */
  prefixBidxList: string[];
};

/** Cliente como esta armazenado (cifrado). */
export type StoredCustomer = {
  id: string;
  nomeEnc: Buffer;
  emailEnc: Buffer;
  emailBidx: string;
  nomeMasked: string;
  emailMasked: string;
  status: CustomerStatus;
  criadoEm: Date;
};

export interface CustomerRepository {
  create(input: CreateCustomerInput): Promise<StoredCustomer>;
  findById(id: string): Promise<StoredCustomer | null>;
  /** Busca exata via blind index do email completo. */
  findByEmailBidx(emailBidx: string): Promise<StoredCustomer | null>;
  /** Busca por prefixo via tokens de prefixo (blind index por prefixo). */
  searchByEmailPrefixBidx(prefixBidx: string, limit: number): Promise<StoredCustomer[]>;
  list(limit: number, offset: number): Promise<StoredCustomer[]>;
  count(): Promise<number>;
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

export interface RampProfileRepository {
  create(input: CreateRampProfileInput): Promise<RampProfile>;
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
  findByTxHash(txHash: string): Promise<Payment | null>;
  listByLink(linkId: string): Promise<Payment[]>;
  listByStatus(status: Payment['status'], limit: number): Promise<Payment[]>;
  sumConfirmedByLink(linkId: string): Promise<bigint>;
  updateConfirmations(paymentId: string, confirmacoes: number): Promise<void>;
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
  listAll(limit: number): Promise<CustomerCredit[]>;
  sumByCustomer(clienteId: string): Promise<number>;
  findByPayment(pagamentoId: string): Promise<CustomerCredit | null>;
}

export type CreateTransferInput = {
  linkId: string;
  deAddress: string;
  paraAddress: string;
  valorBaseUnits: bigint;
  status: TransferStatus;
  txHash?: string | null;
  erro?: string | null;
};

export interface TransferRepository {
  create(input: CreateTransferInput): Promise<InternalTransfer>;
  update(
    id: string,
    patch: Partial<
      Pick<InternalTransfer, 'status' | 'txHash' | 'erro' | 'valorBaseUnits' | 'paraAddress'>
    >,
  ): Promise<void>;
  findByLink(linkId: string): Promise<InternalTransfer[]>;
  listByStatus(status: TransferStatus, limit: number): Promise<InternalTransfer[]>;
}

export interface CursorRepository {
  get(chain: string, tokenContract: string): Promise<ChainCursor | null>;
  set(chain: string, tokenContract: string, bloco: number, hashBloco: string | null): Promise<void>;
}

/**
 * Alocacao atomica do indice HD. Nao pode devolver o mesmo indice duas
 * vezes (endereco derivado e publico: reutilizar expoe fundos antigos).
 */
export interface IndexAllocator {
  allocate(scope: string): Promise<number>;
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
  indices: IndexAllocator;
  audit: AuditRepository;
};
