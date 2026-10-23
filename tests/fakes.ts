import { randomUUID } from 'node:crypto';
import type {
  AnchorRepository,
  ApiClientRepository,
  ApiClientWalletRepository,
  AuditRepository,
  CreateApiClientInput,
  CreateApiClientWalletInput,
  CreateLinkInput,
  CreateRampProfileInput,
  CreateTransferInput,
  CreateWebhookEventInput,
  CursorRepository,
  IndexAllocator,
  LinkRepository,
  MotorRepositories,
  NonceRepository,
  PaymentRepository,
  RampProfileRepository,
  RecordAuditInput,
  SettlementPatch,
  TransferRepository,
  UpdateApiClientInput,
  UpdateRampProfileInput,
  UpsertPaymentInput,
  WebhookOutboxRepository,
} from '../src/core/ports/index.js';
import type {
  ApiClient,
  ApiClientWallet,
  AuditEvent,
  ChainAnchor,
  ChainCursor,
  InternalTransfer,
  LinkStatus,
  Payment,
  PaymentLink,
  RampProfile,
  TransferKind,
  TransferStatus,
  WebhookEvent,
} from '../src/core/domain/types.js';

export class FakeApiClientRepository implements ApiClientRepository {
  readonly rows: ApiClient[] = [];

  async create(input: CreateApiClientInput): Promise<ApiClient> {
    const row: ApiClient = {
      id: input.id,
      nome: input.nome,
      apiKeyPrefix: input.apiKeyPrefix,
      apiKeyHash: input.apiKeyHash,
      webhookUrl: input.webhookUrl,
      webhookSecret: input.webhookSecret,
      requestSecret: input.requestSecret,
      status: 'ativo',
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async findById(id: string): Promise<ApiClient | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async findByApiKeyHash(apiKeyHash: string): Promise<ApiClient | null> {
    const row = this.rows.find((r) => r.apiKeyHash === apiKeyHash);
    return row ? { ...row } : null;
  }

  async list(): Promise<ApiClient[]> {
    return this.rows.map((r) => ({ ...r }));
  }

  async update(id: string, input: UpdateApiClientInput): Promise<ApiClient | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    if (input.nome !== undefined) row.nome = input.nome;
    if (input.webhookUrl !== undefined) row.webhookUrl = input.webhookUrl;
    if (input.status !== undefined) row.status = input.status;
    return { ...row };
  }

  async rotateKey(
    id: string,
    apiKeyHash: string,
    apiKeyPrefix: string,
    requestSecret: string,
  ): Promise<ApiClient | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.apiKeyHash = apiKeyHash;
    row.apiKeyPrefix = apiKeyPrefix;
    row.requestSecret = requestSecret;
    return { ...row };
  }

  async rotateWebhookSecret(id: string, webhookSecret: string): Promise<ApiClient | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.webhookSecret = webhookSecret;
    return { ...row };
  }
}

export class FakeApiClientWalletRepository implements ApiClientWalletRepository {
  readonly rows: ApiClientWallet[] = [];

  async create(input: CreateApiClientWalletInput): Promise<ApiClientWallet> {
    const row: ApiClientWallet = {
      id: randomUUID(),
      apiClienteId: input.apiClienteId,
      label: input.label,
      chain: input.chain,
      address: input.address,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async findById(id: string): Promise<ApiClientWallet | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async findByClientAndAddress(
    apiClienteId: string,
    address: string,
  ): Promise<ApiClientWallet | null> {
    const row = this.rows.find(
      (r) =>
        r.apiClienteId === apiClienteId &&
        r.address.toLowerCase() === address.toLowerCase(),
    );
    return row ? { ...row } : null;
  }

  async listByClient(apiClienteId: string): Promise<ApiClientWallet[]> {
    return this.rows.filter((r) => r.apiClienteId === apiClienteId).map((r) => ({ ...r }));
  }

  async listAll(): Promise<ApiClientWallet[]> {
    return this.rows.map((r) => ({ ...r }));
  }
}

export class FakeNonceRepository implements NonceRepository {
  readonly used = new Set<string>();

  async use(apiClienteId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const key = `${apiClienteId}:${nonce}`;
    if (this.used.has(key)) return false;
    this.used.add(key);
    void expiresAt;
    return true;
  }

  async cleanup(now: Date): Promise<number> {
    void now;
    return 0;
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
    return { ...row };
  }

  async update(id: string, input: UpdateRampProfileInput): Promise<RampProfile | null> {
    const row = this.rows.find((x) => x.id === id);
    if (!row) return null;
    if (input.label !== undefined) row.label = input.label;
    if (input.fiatCurrency !== undefined) row.fiatCurrency = input.fiatCurrency;
    if (input.baseUrl !== undefined) row.baseUrl = input.baseUrl;
    if (input.paramStyle !== undefined) row.paramStyle = input.paramStyle;
    if (input.hostAppName !== undefined) row.hostAppName = input.hostAppName;
    if (input.hostLogoUrl !== undefined) row.hostLogoUrl = input.hostLogoUrl;
    if (input.hostApiKey !== undefined) row.hostApiKey = input.hostApiKey;
    if (input.rampAssetKey !== undefined) row.rampAssetKey = input.rampAssetKey;
    if (input.taxaTokenPorFiatBaseUnits !== undefined) {
      row.taxaTokenPorFiatBaseUnits = input.taxaTokenPorFiatBaseUnits;
    }
    return { ...row };
  }

  async findById(id: string): Promise<RampProfile | null> {
    const row = this.rows.find((x) => x.id === id);
    return row ? { ...row } : null;
  }

  async list(): Promise<RampProfile[]> {
    return this.rows.map((r) => ({ ...r }));
  }
}

export class FakeLinkRepository implements LinkRepository {
  readonly rows: PaymentLink[] = [];

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const row: PaymentLink = {
      ...input,
      valorRecebidoBaseUnits: 0n,
      motivoNaoRealizado: null,
      reembolsado: false,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async findById(id: string): Promise<PaymentLink | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async findByDepositAddress(address: string): Promise<PaymentLink | null> {
    const row = this.rows.find(
      (r) => r.enderecoDeposito.toLowerCase() === address.toLowerCase(),
    );
    return row ? { ...row } : null;
  }

  async findByPageTokenHash(hash: string): Promise<PaymentLink | null> {
    const row = this.rows.find((r) => r.pageTokenHash === hash);
    return row ? { ...row } : null;
  }

  async findByExternalId(apiClienteId: string, externalId: string): Promise<PaymentLink | null> {
    const row = this.rows.find(
      (r) => r.apiClienteId === apiClienteId && r.externalId === externalId,
    );
    return row ? { ...row } : null;
  }

  async findByIdempotencyKey(
    apiClienteId: string,
    idempotencyKey: string,
  ): Promise<PaymentLink | null> {
    const row = this.rows.find(
      (r) => r.apiClienteId === apiClienteId && r.idempotencyKey === idempotencyKey,
    );
    return row ? { ...row } : null;
  }

  async listByClient(apiClienteId: string, limit: number): Promise<PaymentLink[]> {
    return this.rows
      .filter((r) => r.apiClienteId === apiClienteId)
      .sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listAll(limit: number): Promise<PaymentLink[]> {
    return this.rows
      .slice()
      .sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listByStatus(status: LinkStatus, limit: number): Promise<PaymentLink[]> {
    return this.rows.filter((r) => r.status === status).slice(0, limit).map((r) => ({ ...r }));
  }

  async listExpiredPages(now: Date, limit: number): Promise<PaymentLink[]> {
    return this.rows
      .filter((r) => r.status === 'aguardando' && r.expiraEm <= now)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listDueSettlement(now: Date, limit: number): Promise<PaymentLink[]> {
    return this.rows
      .filter(
        (r) =>
          (r.status === 'expirado' || r.status === 'parcial') &&
          r.liquidacaoAte <= now,
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async updateStatus(id: string, status: LinkStatus): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = status;
  }

  async updateSettlement(id: string, patch: SettlementPatch): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    if (patch.motivoNaoRealizado !== undefined) row.motivoNaoRealizado = patch.motivoNaoRealizado;
    if (patch.valorRecebidoBaseUnits !== undefined) {
      row.valorRecebidoBaseUnits = patch.valorRecebidoBaseUnits;
    }
    if (patch.reembolsado !== undefined) row.reembolsado = patch.reembolsado;
  }

  async listDepositAddresses(statuses: LinkStatus[]): Promise<string[]> {
    return this.rows.filter((r) => statuses.includes(r.status)).map((r) => r.enderecoDeposito);
  }
}

export class FakePaymentRepository implements PaymentRepository {
  readonly rows: Payment[] = [];

  constructor(private readonly links: FakeLinkRepository) {}

  async upsert(input: UpsertPaymentInput): Promise<Payment> {
    const existing = this.rows.find(
      (r) =>
        r.txHash.toLowerCase() === input.txHash.toLowerCase() &&
        r.logIndex === input.logIndex,
    );
    if (existing) return { ...existing };
    const row: Payment = {
      id: randomUUID(),
      ...input,
      txHash: input.txHash.toLowerCase(),
      confirmacoes: 0,
      detectadoEm: input.detectadoEm,
      confirmadoEm: input.status === 'confirmado' ? new Date() : null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async confirm(input: { paymentId: string; confirmacoes: number }): Promise<Payment> {
    const row = this.rows.find((r) => r.id === input.paymentId);
    if (!row) throw new Error('pagamento nao encontrado');
    row.status = 'confirmado';
    row.confirmacoes = input.confirmacoes;
    row.confirmadoEm = new Date();
    return { ...row };
  }

  async findByTxHash(txHash: string): Promise<Payment | null> {
    const row = this.rows.find((r) => r.txHash.toLowerCase() === txHash.toLowerCase());
    return row ? { ...row } : null;
  }

  async listByLink(linkId: string): Promise<Payment[]> {
    return this.rows.filter((r) => r.linkId === linkId).map((r) => ({ ...r }));
  }

  async listByStatus(status: Payment['status'], limit: number): Promise<Payment[]> {
    return this.rows.filter((r) => r.status === status).slice(0, limit).map((r) => ({ ...r }));
  }

  async listForReconciliation(limit: number): Promise<Payment[]> {
    return this.rows
      .filter((p) => {
        const link = this.links.rows.find((l) => l.id === p.linkId);
        return (
          p.status === 'confirmado' &&
          link !== undefined &&
          ['aguardando', 'expirado', 'parcial', 'nao_realizado'].includes(link.status)
        );
      })
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async sumConfirmedByLink(linkId: string): Promise<bigint> {
    return this.rows
      .filter((r) => r.linkId === linkId && r.status === 'confirmado')
      .reduce((total, r) => total + r.valorBaseUnits, 0n);
  }

  async updateConfirmations(paymentId: string, confirmacoes: number): Promise<void> {
    const row = this.rows.find((r) => r.id === paymentId);
    if (row) row.confirmacoes = confirmacoes;
  }

  async listConfirmedAboveBlock(chain: string, bloco: number): Promise<Payment[]> {
    return this.rows
      .filter((p) => {
        const link = this.links.rows.find((l) => l.id === p.linkId);
        return (
          link?.chain === chain &&
          p.bloco > bloco &&
          ['detectado', 'confirmado'].includes(p.status)
        );
      })
      .map((r) => ({ ...r }));
  }

  async revertAboveBlock(chain: string, bloco: number): Promise<number> {
    let n = 0;
    for (const payment of this.rows) {
      const link = this.links.rows.find((l) => l.id === payment.linkId);
      if (
        link?.chain === chain &&
        payment.bloco > bloco &&
        ['detectado', 'confirmado'].includes(payment.status)
      ) {
        payment.status = 'revertido';
        payment.confirmadoEm = null;
        payment.confirmacoes = 0;
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
      kind: input.kind ?? 'sweep',
      rawTransaction: input.rawTransaction ?? null,
      unsignedTransaction: input.unsignedTransaction ?? null,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async update(
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
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  }

  async existsByNonce(linkId: string, nonce: number): Promise<boolean> {
    return this.rows.some((r) => r.linkId === linkId && r.nonce === nonce);
  }

  async findByLinkKindNonce(
    linkId: string,
    kind: TransferKind,
    nonce: number,
  ): Promise<InternalTransfer | null> {
    const row = this.rows.find(
      (r) => r.linkId === linkId && r.kind === kind && r.nonce === nonce,
    );
    return row ? { ...row } : null;
  }

  async listInFlight(limit: number): Promise<InternalTransfer[]> {
    return this.rows
      .filter(
        (r) =>
          ['pendente', 'patrocinado', 'enviado'].includes(r.status) &&
          (r.rawTransaction !== null || r.txHash !== null),
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async revertAboveBlock(chain: string, bloco: number): Promise<number> {
    let n = 0;
    for (const row of this.rows) {
      if (
        row.chain === chain &&
        row.bloco !== null &&
        row.bloco > bloco &&
        ['enviado', 'confirmado', 'patrocinado'].includes(row.status)
      ) {
        Object.assign(row, {
          status: 'pendente',
          txHash: null,
          rawTransaction: null,
          unsignedTransaction: null,
          bloco: null,
          erro: 'reorg: refazer sweep',
        });
        n++;
      }
    }
    return n;
  }

  async findById(id: string): Promise<InternalTransfer | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async findByLink(linkId: string): Promise<InternalTransfer[]> {
    return this.rows.filter((r) => r.linkId === linkId).map((r) => ({ ...r }));
  }

  async listByStatus(status: TransferStatus, limit: number): Promise<InternalTransfer[]> {
    return this.rows.filter((r) => r.status === status).slice(0, limit).map((r) => ({ ...r }));
  }
}

export class FakeWebhookOutboxRepository implements WebhookOutboxRepository {
  readonly rows: WebhookEvent[] = [];

  async enqueue(input: CreateWebhookEventInput): Promise<WebhookEvent | null> {
    if (
      this.rows.some(
        (r) => r.linkId === input.linkId && r.eventType === input.eventType,
      )
    ) {
      return null;
    }
    const row: WebhookEvent = {
      id: randomUUID(),
      apiClienteId: input.apiClienteId,
      linkId: input.linkId,
      eventType: input.eventType,
      payload: input.payload,
      status: 'pendente',
      attempts: 0,
      nextAttemptEm: input.nextAttemptEm,
      lastError: null,
      deliveredEm: null,
      criadoEm: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async findById(id: string): Promise<WebhookEvent | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async listDue(now: Date, limit: number): Promise<WebhookEvent[]> {
    return this.rows
      .filter((r) => r.status === 'pendente' && r.nextAttemptEm <= now)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listByLink(linkId: string): Promise<WebhookEvent[]> {
    return this.rows.filter((r) => r.linkId === linkId).map((r) => ({ ...r }));
  }

  async listAll(limit: number): Promise<WebhookEvent[]> {
    return this.rows
      .slice()
      .sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async markDelivered(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = 'entregue';
    row.deliveredEm = new Date();
    row.lastError = null;
  }

  async markFailed(
    id: string,
    input: {
      attempts: number;
      nextAttemptEm: Date;
      lastError: string;
      status?: 'pendente' | 'falhou';
    },
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.attempts = input.attempts;
    row.nextAttemptEm = input.nextAttemptEm;
    row.lastError = input.lastError;
    row.status = input.status ?? 'pendente';
  }

  async replay(id: string, now: Date): Promise<WebhookEvent | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.status = 'pendente';
    row.attempts = 0;
    row.nextAttemptEm = now;
    row.lastError = null;
    row.deliveredEm = null;
    return { ...row };
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
    const exists = this.rows.find(
      (r) =>
        r.chain === anchor.chain &&
        r.tokenContract === anchor.tokenContract.toLowerCase() &&
        r.bloco === anchor.bloco,
    );
    if (exists) return;
    this.rows.push({ ...anchor, tokenContract: anchor.tokenContract.toLowerCase() });
  }

  async list(chain: string, tokenContract: string, limit: number): Promise<ChainAnchor[]> {
    return this.rows
      .filter(
        (r) => r.chain === chain && r.tokenContract === tokenContract.toLowerCase(),
      )
      .sort((a, b) => b.bloco - a.bloco)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async pruneAfter(chain: string, tokenContract: string, bloco: number): Promise<void> {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i]!;
      if (
        row.chain === chain &&
        row.tokenContract === tokenContract.toLowerCase() &&
        row.bloco > bloco
      ) {
        this.rows.splice(i, 1);
      }
    }
  }

  async oldest(chain: string, tokenContract: string): Promise<ChainAnchor | null> {
    const filtered = this.rows.filter(
      (r) => r.chain === chain && r.tokenContract === tokenContract.toLowerCase(),
    );
    if (filtered.length === 0) return null;
    return { ...filtered.reduce((a, b) => (a.bloco <= b.bloco ? a : b)) };
  }
}

export class FakeIndexAllocator implements IndexAllocator {
  private readonly counters = new Map<string, number>();

  async allocate(scope: string, maxIndex?: number): Promise<number> {
    const next = this.counters.get(scope) ?? 0;
    if (maxIndex !== undefined && next > maxIndex) {
      throw new Error(`limite de indices HD atingido: proximo=${next}, maximo=${maxIndex}`);
    }
    this.counters.set(scope, next + 1);
    return next;
  }

  async release(scope: string, indice: number): Promise<void> {
    const next = this.counters.get(scope) ?? 0;
    if (indice === next - 1) this.counters.set(scope, indice);
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
    return this.rows
      .slice()
      .sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime())
      .slice(0, limit);
  }
}

export function createFakeRepositories(): MotorRepositories {
  const links = new FakeLinkRepository();
  return {
    apiClients: new FakeApiClientRepository(),
    apiClientWallets: new FakeApiClientWalletRepository(),
    nonces: new FakeNonceRepository(),
    rampProfiles: new FakeRampProfileRepository(),
    links,
    payments: new FakePaymentRepository(links),
    transfers: new FakeTransferRepository(),
    webhooks: new FakeWebhookOutboxRepository(),
    cursors: new FakeCursorRepository(),
    anchors: new FakeAnchorRepository(),
    indices: new FakeIndexAllocator(),
    audit: new FakeAuditRepository(),
  };
}
