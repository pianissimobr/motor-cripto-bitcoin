import { randomUUID } from 'node:crypto';
import type {
  AuditRepository,
  ColdWalletRepository,
  CreateColdWalletInput,
  CreateCreditInput,
  CreateCustomerInput,
  CreateLinkInput,
  CreateRampProfileInput,
  CreateTransferInput,
  CreditRepository,
  CursorRepository,
  CustomerRepository,
  IndexAllocator,
  LinkRepository,
  MotorRepositories,
  PaymentRepository,
  RampProfileRepository,
  RecordAuditInput,
  StoredCustomer,
  TransferRepository,
  UpsertPaymentInput,
} from '../src/core/ports/index.js';
import type {
  AuditEvent,
  ChainCursor,
  ColdWallet,
  CustomerCredit,
  InternalTransfer,
  LinkStatus,
  Payment,
  PaymentLink,
  RampProfile,
} from '../src/core/domain/types.js';

/**
 * Repositorios em memoria para testar o core sem banco.
 * Implementam os mesmos ports usados em producao (Drizzle).
 */

export class FakeCustomerRepository implements CustomerRepository {
  readonly rows: StoredCustomer[] = [];

  async create(input: CreateCustomerInput): Promise<StoredCustomer> {
    const row: StoredCustomer = {
      id: input.id,
      nomeEnc: input.nomeEnc,
      emailEnc: input.emailEnc,
      emailBidx: input.emailBidx,
      nomeMasked: input.nomeMasked,
      emailMasked: input.emailMasked,
      status: input.status ?? 'ativo',
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async findById(id: string): Promise<StoredCustomer | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async findByEmailBidx(emailBidx: string): Promise<StoredCustomer | null> {
    return this.rows.find((r) => r.emailBidx === emailBidx) ?? null;
  }

  async searchByEmailPrefixBidx(prefixBidx: string, limit: number): Promise<StoredCustomer[]> {
    return this.rows.filter((r) => r.emailBidx.startsWith(prefixBidx)).slice(0, limit);
  }

  async list(limit: number, offset: number): Promise<StoredCustomer[]> {
    return this.rows.slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return this.rows.length;
  }
}

export class FakeRampProfileRepository implements RampProfileRepository {
  readonly rows: RampProfile[] = [];

  async create(input: CreateRampProfileInput): Promise<RampProfile> {
    const row: RampProfile = {
      id: randomUUID(),
      label: input.label,
      chain: input.chain,
      asset: input.asset,
      tokenContract: input.tokenContract,
      decimals: input.decimals,
      fiatCurrency: input.fiatCurrency,
      baseUrl: input.baseUrl,
      paramStyle: input.paramStyle,
      hostAppName: input.hostAppName,
      hostLogoUrl: input.hostLogoUrl ?? null,
      hostApiKey: input.hostApiKey ?? null,
      taxaTokenPorFiatBaseUnits: input.taxaTokenPorFiatBaseUnits ?? null,
      rampAssetKey: input.rampAssetKey ?? null,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async findById(id: string): Promise<RampProfile | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async list(): Promise<RampProfile[]> {
    return this.rows;
  }
}

export class FakeColdWalletRepository implements ColdWalletRepository {
  readonly rows: ColdWallet[] = [];

  async create(input: CreateColdWalletInput): Promise<ColdWallet> {
    const row: ColdWallet = {
      id: randomUUID(),
      label: input.label,
      address: input.address,
      chain: input.chain,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async findById(id: string): Promise<ColdWallet | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async findByAddress(address: string): Promise<ColdWallet | null> {
    return this.rows.find((r) => r.address.toLowerCase() === address.toLowerCase()) ?? null;
  }

  async list(): Promise<ColdWallet[]> {
    return this.rows;
  }
}

export class FakeLinkRepository implements LinkRepository {
  readonly rows: PaymentLink[] = [];

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const row: PaymentLink = {
      id: randomUUID(),
      clienteId: input.clienteId,
      rampProfileId: input.rampProfileId,
      chain: input.chain,
      asset: input.asset,
      tokenContract: input.tokenContract,
      decimals: input.decimals,
      moedaFiat: input.moedaFiat,
      valorFiatCentavos: input.valorFiatCentavos,
      valorFiatUnidades: input.valorFiatUnidades,
      taxaTokenPorFiatBaseUnits: input.taxaTokenPorFiatBaseUnits,
      expectedBaseUnits: input.expectedBaseUnits,
      indiceHd: input.indiceHd,
      caminhoDerivacao: input.caminhoDerivacao,
      enderecoDeposito: input.enderecoDeposito,
      rampUrl: input.rampUrl,
      status: input.status,
      expiraEm: input.expiraEm,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async findById(id: string): Promise<PaymentLink | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async findByDepositAddress(address: string): Promise<PaymentLink | null> {
    return (
      this.rows.find((r) => r.enderecoDeposito.toLowerCase() === address.toLowerCase()) ?? null
    );
  }

  async listByCustomer(clienteId: string): Promise<PaymentLink[]> {
    return this.rows.filter((r) => r.clienteId === clienteId);
  }

  async listAll(limit: number): Promise<PaymentLink[]> {
    return this.rows.slice(0, limit);
  }

  async listByStatus(status: LinkStatus, limit: number): Promise<PaymentLink[]> {
    return this.rows.filter((r) => r.status === status).slice(0, limit);
  }

  async updateStatus(id: string, status: LinkStatus): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = status;
  }

  async listDepositAddresses(statuses: LinkStatus[]): Promise<string[]> {
    return this.rows.filter((r) => statuses.includes(r.status)).map((r) => r.enderecoDeposito);
  }
}

export class FakePaymentRepository implements PaymentRepository {
  readonly rows: Payment[] = [];

  async upsert(input: UpsertPaymentInput): Promise<Payment> {
    const existing = this.rows.find(
      (r) => r.txHash === input.txHash && r.logIndex === input.logIndex,
    );
    if (existing) {
      if (input.status === 'confirmado' && existing.status !== 'confirmado') {
        existing.status = 'confirmado';
        existing.confirmadoEm = new Date();
      }
      return existing;
    }
    const row: Payment = {
      id: randomUUID(),
      linkId: input.linkId,
      txHash: input.txHash,
      logIndex: input.logIndex,
      deAddress: input.deAddress,
      paraAddress: input.paraAddress,
      token: input.token,
      valorBaseUnits: input.valorBaseUnits,
      confirmacoes: 0,
      bloco: input.bloco,
      status: input.status,
      detectadoEm: input.detectadoEm,
      confirmadoEm: input.status === 'confirmado' ? new Date() : null,
    };
    this.rows.push(row);
    return row;
  }

  async findByTxHash(txHash: string): Promise<Payment | null> {
    return this.rows.find((r) => r.txHash === txHash) ?? null;
  }

  async listByLink(linkId: string): Promise<Payment[]> {
    return this.rows.filter((r) => r.linkId === linkId);
  }

  async listByStatus(status: Payment['status'], limit: number): Promise<Payment[]> {
    return this.rows.filter((r) => r.status === status).slice(0, limit);
  }

  async sumConfirmedByLink(linkId: string): Promise<bigint> {
    return this.rows
      .filter((r) => r.linkId === linkId && r.status === 'confirmado')
      .reduce((acc, r) => acc + r.valorBaseUnits, 0n);
  }

  async updateConfirmations(paymentId: string, confirmacoes: number): Promise<void> {
    const row = this.rows.find((r) => r.id === paymentId);
    if (row) row.confirmacoes = confirmacoes;
  }
}

export class FakeCreditRepository implements CreditRepository {
  readonly rows: CustomerCredit[] = [];

  async create(input: CreateCreditInput): Promise<CustomerCredit> {
    const existing = this.rows.find((r) => r.pagamentoId === input.pagamentoId);
    if (existing) return existing;
    const row: CustomerCredit = {
      id: randomUUID(),
      clienteId: input.clienteId,
      linkId: input.linkId,
      pagamentoId: input.pagamentoId,
      valorBaseUnits: input.valorBaseUnits,
      valorCentavos: input.valorCentavos,
      moeda: input.moeda,
      status: input.status,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async listByCustomer(clienteId: string): Promise<CustomerCredit[]> {
    return this.rows.filter((r) => r.clienteId === clienteId);
  }

  async listAll(limit: number): Promise<CustomerCredit[]> {
    return this.rows.slice(0, limit);
  }

  async sumByCustomer(clienteId: string): Promise<number> {
    return this.rows
      .filter((r) => r.clienteId === clienteId && r.status === 'liberado')
      .reduce((acc, r) => acc + (r.valorCentavos ?? 0), 0);
  }

  async findByPayment(pagamentoId: string): Promise<CustomerCredit | null> {
    return this.rows.find((r) => r.pagamentoId === pagamentoId) ?? null;
  }
}

export class FakeTransferRepository implements TransferRepository {
  readonly rows: InternalTransfer[] = [];

  async create(input: CreateTransferInput): Promise<InternalTransfer> {
    const row: InternalTransfer = {
      id: randomUUID(),
      linkId: input.linkId,
      deAddress: input.deAddress,
      paraAddress: input.paraAddress,
      valorBaseUnits: input.valorBaseUnits,
      txHash: input.txHash ?? null,
      status: input.status,
      erro: input.erro ?? null,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<InternalTransfer, 'status' | 'txHash' | 'erro' | 'valorBaseUnits' | 'paraAddress'>
    >,
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  }

  async findByLink(linkId: string): Promise<InternalTransfer[]> {
    return this.rows.filter((r) => r.linkId === linkId);
  }

  async listByStatus(status: InternalTransfer['status'], limit: number): Promise<InternalTransfer[]> {
    return this.rows.filter((r) => r.status === status).slice(0, limit);
  }
}

export class FakeCursorRepository implements CursorRepository {
  readonly rows = new Map<string, ChainCursor>();

  private key(chain: string, tokenContract: string) {
    return `${chain}:${tokenContract.toLowerCase()}`;
  }

  async get(chain: string, tokenContract: string): Promise<ChainCursor | null> {
    return this.rows.get(this.key(chain, tokenContract)) ?? null;
  }

  async set(
    chain: string,
    tokenContract: string,
    bloco: number,
    hashBloco: string | null,
  ): Promise<void> {
    this.rows.set(this.key(chain, tokenContract), {
      chain,
      tokenContract: tokenContract.toLowerCase(),
      ultimoBloco: bloco,
      hashBloco,
    });
  }
}

export class FakeIndexAllocator implements IndexAllocator {
  private readonly counters = new Map<string, number>();

  async allocate(scope: string): Promise<number> {
    const next = this.counters.get(scope) ?? 0;
    this.counters.set(scope, next + 1);
    return next;
  }
}

export class FakeAuditRepository implements AuditRepository {
  readonly rows: AuditEvent[] = [];

  async record(input: RecordAuditInput): Promise<void> {
    this.rows.push({
      id: randomUUID(),
      ator: input.ator,
      acao: input.acao,
      entidade: input.entidade,
      entidadeId: input.entidadeId ?? null,
      detalhes: input.detalhes ?? null,
      ip: input.ip ?? null,
      criadoEm: new Date(),
    });
  }

  async list(limit: number): Promise<AuditEvent[]> {
    return this.rows.slice(0, limit);
  }
}

export function createFakeRepositories(): MotorRepositories {
  return {
    customers: new FakeCustomerRepository(),
    rampProfiles: new FakeRampProfileRepository(),
    coldWallets: new FakeColdWalletRepository(),
    links: new FakeLinkRepository(),
    payments: new FakePaymentRepository(),
    credits: new FakeCreditRepository(),
    transfers: new FakeTransferRepository(),
    cursors: new FakeCursorRepository(),
    indices: new FakeIndexAllocator(),
    audit: new FakeAuditRepository(),
  };
}
