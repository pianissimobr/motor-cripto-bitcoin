import { randomUUID } from 'node:crypto';
import type {
  AnchorRepository,
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
  ChainAnchor,
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
    const r = this.rows.find((x) => x.id === id);
    return r ? { ...r } : null;
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
    const r = this.rows.find((x) => x.id === id);
    return r ? { ...r } : null;
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
    const r = this.rows.find((x) => x.id === id);
    return r ? { ...r } : null;
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
      carteiraFriaId: input.carteiraFriaId,
      carteiraFriaEndereco: input.carteiraFriaEndereco,
      rampUrl: input.rampUrl,
      status: input.status,
      expiraEm: input.expiraEm,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async findById(id: string): Promise<PaymentLink | null> {
    // Cópia: um repo real hidrata do banco. Sem isso, updateStatus mutaria
    // o mesmo objeto que o caller já tem em mãos.
    const r = this.rows.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  async findByDepositAddress(address: string): Promise<PaymentLink | null> {
    return (
      this.rows.find((r) => r.enderecoDeposito.toLowerCase() === address.toLowerCase()) ?? null
    );
  }

  async listByCustomer(clienteId: string): Promise<PaymentLink[]> {
    return this.rows.filter((r) => r.clienteId === clienteId).map((r) => ({ ...r }));
  }

  async listAll(limit: number): Promise<PaymentLink[]> {
    return this.rows.slice(0, limit).map((r) => ({ ...r }));
  }

  async listByStatus(status: LinkStatus, limit: number): Promise<PaymentLink[]> {
    return this.rows.filter((r) => r.status === status).slice(0, limit).map((r) => ({ ...r }));
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
    const r = this.rows.find((x) => x.txHash === txHash);
    return r ? { ...r } : null;
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

  async listConfirmedAboveBlock(chain: string, bloco: number): Promise<Payment[]> {
    // O fake nao tem join com links; usa o bloco do proprio pagamento.
    return this.rows
      .filter((r) => r.bloco > bloco && ['detectado', 'confirmado'].includes(r.status))
      .map((r) => ({ ...r }));
  }

  async revertAboveBlock(chain: string, bloco: number): Promise<number> {
    let n = 0;
    for (const r of this.rows) {
      if (r.bloco > bloco && ['detectado', 'confirmado'].includes(r.status)) {
        Object.assign(r, { status: 'revertido', confirmadoEm: null, confirmacoes: 0 });
        n++;
      }
    }
    return n;
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
    const r = this.rows.find((x) => x.pagamentoId === pagamentoId);
    return r ? { ...r } : null;
  }

  async revertByPaymentIds(pagamentoIds: string[]): Promise<number> {
    const set = new Set(pagamentoIds);
    let n = 0;
    for (const r of this.rows) {
      if (set.has(r.pagamentoId) && ['pendente', 'liberado'].includes(r.status)) {
        r.status = 'revertido';
        n++;
      }
    }
    return n;
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
      chain: input.chain,
      bloco: input.bloco ?? null,
      nonce: input.nonce ?? null,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        InternalTransfer,
        'status' | 'txHash' | 'erro' | 'valorBaseUnits' | 'paraAddress' | 'bloco'
      >
    >,
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  }

  async existsByNonce(linkId: string, nonce: number): Promise<boolean> {
    return this.rows.some((r) => r.linkId === linkId && r.nonce === nonce);
  }

  async revertAboveBlock(chain: string, bloco: number): Promise<number> {
    let n = 0;
    for (const r of this.rows) {
      if (
        r.chain === chain &&
        r.bloco !== null &&
        r.bloco > bloco &&
        ['enviado', 'confirmado', 'patrocinado'].includes(r.status)
      ) {
        Object.assign(r, { status: 'pendente', txHash: null, bloco: null, erro: 'reorg: refazer sweep' });
        n++;
      }
    }
    return n;
  }

  async findByLink(linkId: string): Promise<InternalTransfer[]> {
    return this.rows.filter((r) => r.linkId === linkId);
  }

  async listByStatus(status: InternalTransfer['status'], limit: number): Promise<InternalTransfer[]> {
    return this.rows.filter((r) => r.status === status).slice(0, limit).map((r) => ({ ...r }));
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

  async rewind(
    chain: string,
    tokenContract: string,
    bloco: number,
    hashBloco: string | null,
  ): Promise<void> {
    await this.set(chain, tokenContract, bloco, hashBloco);
  }
}

export class FakeAnchorRepository implements AnchorRepository {
  readonly rows: ChainAnchor[] = [];

  async record(anchor: ChainAnchor): Promise<void> {
    const existe = this.rows.find(
      (r) =>
        r.chain === anchor.chain &&
        r.tokenContract === anchor.tokenContract.toLowerCase() &&
        r.bloco === anchor.bloco,
    );
    if (existe) return;
    this.rows.push({
      ...anchor,
      tokenContract: anchor.tokenContract.toLowerCase(),
    });
  }

  async list(chain: string, tokenContract: string, limit: number): Promise<ChainAnchor[]> {
    return this.rows
      .filter(
        (r) =>
          r.chain === chain && r.tokenContract === tokenContract.toLowerCase(),
      )
      .sort((a, b) => b.bloco - a.bloco)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async pruneAfter(chain: string, tokenContract: string, bloco: number): Promise<void> {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (
        r.chain === chain &&
        r.tokenContract === tokenContract.toLowerCase() &&
        r.bloco > bloco
      ) {
        this.rows.splice(i, 1);
      }
    }
  }

  async oldest(chain: string, tokenContract: string): Promise<ChainAnchor | null> {
    const filtradas = this.rows.filter(
      (r) => r.chain === chain && r.tokenContract === tokenContract.toLowerCase(),
    );
    if (filtradas.length === 0) return null;
    return { ...filtradas.reduce((a, b) => (a.bloco <= b.bloco ? a : b)) };
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
    // Espelha o repositorio real: mais recente primeiro.
    return this.rows
      .slice()
      .sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime())
      .slice(0, limit);
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
    anchors: new FakeAnchorRepository(),
    indices: new FakeIndexAllocator(),
    audit: new FakeAuditRepository(),
  };
}
