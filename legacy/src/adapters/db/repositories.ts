import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalAuditPreimage } from '../../core/audit-preimage.js';
import { checksumAddress, normalizeAddress } from '../../core/domain/address.js';
import { HD_INDEX_SCOPE } from '../../core/hd/index-scope.js';
import { DataCipher } from '../../core/crypto/cipher.js';
import type { Database } from './client.js';
import {
  apiClienteWallets,
  apiClientes,
  apiNonces,
  chainAnchors,
  chainCursors,
  eventosAuditoria,
  hdIndices,
  linksGerados,
  linksPagos,
  movimentosInternos,
  rampProfiles,
  webhookOutbox,
} from './schema.js';
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
} from '../../core/ports/index.js';
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
  WebhookStatus,
} from '../../core/domain/types.js';

/**
 * Implementacao dos ports do motor sobre Drizzle/Postgres.
 *
 * Segredos (webhook secret, page token) sao gravados cifrados com o id do
 * registro como AAD. A API key e gravada apenas como SHA-256.
 */

const AUDIT_LOCK_ID = 7_315_902_411;

const enc = (buf: Buffer): string => buf.toString('base64');
const dec = (value: string): Buffer => Buffer.from(value, 'base64');

function toBigInt(value: bigint | string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

function toNumber(value: bigint | string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* API clients                                                         */
/* ------------------------------------------------------------------ */

function toApiClient(
  row: typeof apiClientes.$inferSelect,
  webhookSecret: string,
  requestSecret: string,
): ApiClient {
  return {
    id: row.id,
    nome: row.nome,
    apiKeyPrefix: row.apiKeyPrefix,
    apiKeyHash: row.apiKeyHash,
    webhookUrl: row.webhookUrl,
    webhookSecret,
    requestSecret,
    status: row.status as ApiClientStatus,
    criadoEm: row.criadoEm,
  };
}

class DrizzleApiClientRepository implements ApiClientRepository {
  constructor(
    private readonly db: Database,
    private readonly cipher: DataCipher | null,
  ) {}

  private seal(id: string, secret: string): string {
    if (!this.cipher) return secret;
    return enc(this.cipher.encrypt(secret, id));
  }

  private open(id: string, stored: string): string {
    if (!this.cipher) return stored;
    try {
      return this.cipher.decrypt(dec(stored), id);
    } catch {
      // Compatibilidade com um banco criado antes da cifragem.
      return stored;
    }
  }

  async create(input: CreateApiClientInput): Promise<ApiClient> {
    const [row] = await this.db
      .insert(apiClientes)
      .values({
        id: input.id,
        nome: input.nome,
        apiKeyHash: input.apiKeyHash,
        apiKeyPrefix: input.apiKeyPrefix,
        webhookUrl: input.webhookUrl,
        webhookSecretEnc: this.seal(input.id, input.webhookSecret),
        requestSecretEnc: this.seal(input.id, input.requestSecret),
      })
      .returning();
    if (!row) throw new Error('falha ao criar cliente da API');
    return toApiClient(row, input.webhookSecret, input.requestSecret);
  }

  async findById(id: string): Promise<ApiClient | null> {
    const [row] = await this.db.select().from(apiClientes).where(eq(apiClientes.id, id)).limit(1);
    return row
      ? toApiClient(
          row,
          this.open(row.id, row.webhookSecretEnc),
          this.open(row.id, row.requestSecretEnc),
        )
      : null;
  }

  async findByApiKeyHash(apiKeyHash: string): Promise<ApiClient | null> {
    const [row] = await this.db
      .select()
      .from(apiClientes)
      .where(eq(apiClientes.apiKeyHash, apiKeyHash))
      .limit(1);
    return row
      ? toApiClient(
          row,
          this.open(row.id, row.webhookSecretEnc),
          this.open(row.id, row.requestSecretEnc),
        )
      : null;
  }

  async list(): Promise<ApiClient[]> {
    const rows = await this.db.select().from(apiClientes).orderBy(asc(apiClientes.criadoEm));
    return rows.map((row) =>
      toApiClient(
        row,
        this.open(row.id, row.webhookSecretEnc),
        this.open(row.id, row.requestSecretEnc),
      ),
    );
  }

  async update(id: string, input: UpdateApiClientInput): Promise<ApiClient | null> {
    const values: Partial<typeof apiClientes.$inferInsert> = {};
    if (input.nome !== undefined) values.nome = input.nome;
    if (input.webhookUrl !== undefined) values.webhookUrl = input.webhookUrl;
    if (input.status !== undefined) values.status = input.status;
    if (Object.keys(values).length === 0) return this.findById(id);
    const [row] = await this.db
      .update(apiClientes)
      .set(values)
      .where(eq(apiClientes.id, id))
      .returning();
    return row
      ? toApiClient(
          row,
          this.open(row.id, row.webhookSecretEnc),
          this.open(row.id, row.requestSecretEnc),
        )
      : null;
  }

  async rotateKey(
    id: string,
    apiKeyHash: string,
    apiKeyPrefix: string,
    requestSecret: string,
  ): Promise<ApiClient | null> {
    const [row] = await this.db
      .update(apiClientes)
      .set({
        apiKeyHash,
        apiKeyPrefix,
        requestSecretEnc: this.seal(id, requestSecret),
      })
      .where(eq(apiClientes.id, id))
      .returning();
    return row
      ? toApiClient(
          row,
          this.open(row.id, row.webhookSecretEnc),
          requestSecret,
        )
      : null;
  }

  async rotateWebhookSecret(id: string, webhookSecret: string): Promise<ApiClient | null> {
    const [row] = await this.db
      .update(apiClientes)
      .set({ webhookSecretEnc: this.seal(id, webhookSecret) })
      .where(eq(apiClientes.id, id))
      .returning();
    return row
      ? toApiClient(
          row,
          webhookSecret,
          this.open(row.id, row.requestSecretEnc),
        )
      : null;
  }
}

function toApiClientWallet(row: typeof apiClienteWallets.$inferSelect): ApiClientWallet {
  return {
    id: row.id,
    apiClienteId: row.apiClienteId,
    label: row.label,
    chain: row.chain,
    address: checksumAddress(row.address),
    criadoEm: row.criadoEm,
  };
}

class DrizzleApiClientWalletRepository implements ApiClientWalletRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateApiClientWalletInput): Promise<ApiClientWallet> {
    const [row] = await this.db
      .insert(apiClienteWallets)
      .values({
        apiClienteId: input.apiClienteId,
        label: input.label,
        chain: input.chain.toLowerCase(),
        address: normalizeAddress(input.address),
      })
      .returning();
    if (!row) throw new Error('falha ao criar carteira do cliente');
    return toApiClientWallet(row);
  }

  async findById(id: string): Promise<ApiClientWallet | null> {
    const [row] = await this.db
      .select()
      .from(apiClienteWallets)
      .where(eq(apiClienteWallets.id, id))
      .limit(1);
    return row ? toApiClientWallet(row) : null;
  }

  async findByClientAndAddress(
    apiClienteId: string,
    address: string,
  ): Promise<ApiClientWallet | null> {
    const [row] = await this.db
      .select()
      .from(apiClienteWallets)
      .where(
        and(
          eq(apiClienteWallets.apiClienteId, apiClienteId),
          eq(apiClienteWallets.address, normalizeAddress(address)),
        ),
      )
      .limit(1);
    return row ? toApiClientWallet(row) : null;
  }

  async listByClient(apiClienteId: string): Promise<ApiClientWallet[]> {
    const rows = await this.db
      .select()
      .from(apiClienteWallets)
      .where(eq(apiClienteWallets.apiClienteId, apiClienteId))
      .orderBy(asc(apiClienteWallets.label));
    return rows.map(toApiClientWallet);
  }

  async listAll(): Promise<ApiClientWallet[]> {
    const rows = await this.db
      .select()
      .from(apiClienteWallets)
      .orderBy(asc(apiClienteWallets.criadoEm));
    return rows.map(toApiClientWallet);
  }
}

class DrizzleNonceRepository implements NonceRepository {
  constructor(private readonly db: Database) {}

  async use(apiClienteId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const rows = await this.db
      .insert(apiNonces)
      .values({ apiClienteId, nonce, expiraEm: expiresAt })
      .onConflictDoNothing()
      .returning({ nonce: apiNonces.nonce });
    return rows.length > 0;
  }

  async cleanup(now: Date): Promise<number> {
    const rows = await this.db
      .delete(apiNonces)
      .where(lte(apiNonces.expiraEm, now))
      .returning({ nonce: apiNonces.nonce });
    return rows.length;
  }
}

/* ------------------------------------------------------------------ */
/* Ramp profiles                                                       */
/* ------------------------------------------------------------------ */

function toRampProfile(
  row: typeof rampProfiles.$inferSelect,
  hostApiKey: string | null,
): RampProfile {
  return {
    id: row.id,
    label: row.label,
    chain: row.chain.toLowerCase(),
    asset: row.asset,
    tokenContract: row.tokenContract.toLowerCase(),
    decimals: row.decimals,
    fiatCurrency: row.fiatCurrency,
    baseUrl: row.baseUrl,
    paramStyle: row.paramStyle as ParamStyle,
    hostAppName: row.hostAppName,
    hostLogoUrl: row.hostLogoUrl,
    hostApiKey,
    taxaTokenPorFiatBaseUnits: row.taxaTokenPorFiatBaseUnits,
    rampAssetKey: row.rampAssetKey,
    criadoEm: row.criadoEm,
  };
}

class DrizzleRampProfileRepository implements RampProfileRepository {
  constructor(
    private readonly db: Database,
    private readonly cipher: DataCipher | null,
  ) {}

  private seal(id: string, key: string | null | undefined): string | null {
    if (!key) return null;
    if (!this.cipher) return key;
    return enc(this.cipher.encrypt(key, id));
  }

  private async open(id: string, stored: string | null): Promise<string | null> {
    if (!stored) return null;
    if (!this.cipher) return stored;
    try {
      return this.cipher.decrypt(dec(stored), id);
    } catch {
      await this.db
        .update(rampProfiles)
        .set({ hostApiKeyEnc: this.seal(id, stored) })
        .where(eq(rampProfiles.id, id));
      return stored;
    }
  }

  async create(input: CreateRampProfileInput): Promise<RampProfile> {
    const id = randomUUID();
    const [row] = await this.db
      .insert(rampProfiles)
      .values({
        id,
        label: input.label,
        chain: input.chain.toLowerCase(),
        asset: input.asset,
        tokenContract: normalizeAddress(input.tokenContract),
        decimals: input.decimals,
        fiatCurrency: input.fiatCurrency,
        baseUrl: input.baseUrl,
        paramStyle: input.paramStyle,
        hostAppName: input.hostAppName,
        hostLogoUrl: input.hostLogoUrl ?? null,
        hostApiKeyEnc: this.seal(id, input.hostApiKey),
        rampAssetKey: input.rampAssetKey ?? null,
        taxaTokenPorFiatBaseUnits: input.taxaTokenPorFiatBaseUnits ?? null,
      })
      .returning();
    if (!row) throw new Error('falha ao criar perfil Ramp');
    return toRampProfile(row, input.hostApiKey ?? null);
  }

  async update(id: string, input: UpdateRampProfileInput): Promise<RampProfile | null> {
    const values: Partial<typeof rampProfiles.$inferInsert> = {};
    if (input.label !== undefined) values.label = input.label;
    if (input.fiatCurrency !== undefined) values.fiatCurrency = input.fiatCurrency;
    if (input.baseUrl !== undefined) values.baseUrl = input.baseUrl;
    if (input.paramStyle !== undefined) values.paramStyle = input.paramStyle;
    if (input.hostAppName !== undefined) values.hostAppName = input.hostAppName;
    if (input.hostLogoUrl !== undefined) values.hostLogoUrl = input.hostLogoUrl;
    if (input.hostApiKey !== undefined) values.hostApiKeyEnc = this.seal(id, input.hostApiKey);
    if (input.rampAssetKey !== undefined) values.rampAssetKey = input.rampAssetKey;
    if (input.taxaTokenPorFiatBaseUnits !== undefined) {
      values.taxaTokenPorFiatBaseUnits = input.taxaTokenPorFiatBaseUnits;
    }
    if (Object.keys(values).length === 0) return this.findById(id);
    const [row] = await this.db
      .update(rampProfiles)
      .set(values)
      .where(eq(rampProfiles.id, id))
      .returning();
    if (!row) return null;
    return toRampProfile(row, await this.open(row.id, row.hostApiKeyEnc));
  }

  async findById(id: string): Promise<RampProfile | null> {
    const [row] = await this.db.select().from(rampProfiles).where(eq(rampProfiles.id, id)).limit(1);
    if (!row) return null;
    return toRampProfile(row, await this.open(row.id, row.hostApiKeyEnc));
  }

  async list(): Promise<RampProfile[]> {
    const rows = await this.db.select().from(rampProfiles).orderBy(asc(rampProfiles.criadoEm));
    return Promise.all(
      rows.map(async (row) => toRampProfile(row, await this.open(row.id, row.hostApiKeyEnc))),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

class DrizzleLinkRepository implements LinkRepository {
  constructor(
    private readonly db: Database,
    private readonly cipher: DataCipher | null,
  ) {}

  private seal(id: string, token: string): string {
    if (!this.cipher) return token;
    return enc(this.cipher.encrypt(token, id));
  }

  private open(id: string, stored: string): string {
    if (!this.cipher) return stored;
    try {
      return this.cipher.decrypt(dec(stored), id);
    } catch {
      return stored;
    }
  }

  private hydrate(row: typeof linksGerados.$inferSelect): PaymentLink {
    return {
      id: row.id,
      apiClienteId: row.apiClienteId,
      externalId: row.externalId,
      idempotencyKey: row.idempotencyKey,
      requestHash: row.requestHash,
      rampProfileId: row.rampProfileId,
      chain: row.chain,
      asset: row.asset,
      tokenContract: row.tokenContract.toLowerCase(),
      decimals: row.decimals,
      moedaFiat: row.moedaFiat,
      valorFiatCentavos: row.valorFiatCentavos,
      valorFiatUnidades: row.valorFiatUnidades,
      taxaTokenPorFiatBaseUnits: row.taxaTokenPorFiatBaseUnits,
      expectedBaseUnits: row.expectedBaseUnits,
      indiceHd: row.indiceHd,
      caminhoDerivacao: row.caminhoDerivacao,
      enderecoDeposito: checksumAddress(row.enderecoDeposito),
      walletAddress: checksumAddress(row.walletAddress),
      pageToken: this.open(row.id, row.pageTokenEnc),
      pageTokenHash: row.pageTokenHash,
      rampUrl: row.rampUrl,
      status: row.status as LinkStatus,
      motivoNaoRealizado: row.motivoNaoRealizado as NaoRealizadoMotivo | null,
      valorRecebidoBaseUnits: row.valorRecebidoBaseUnits,
      reembolsado: row.reembolsado,
      expiraEm: row.expiraEm,
      liquidacaoAte: row.liquidacaoAte,
      criadoEm: row.criadoEm,
    };
  }

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(linksGerados)
        .values({
          id: input.id,
          apiClienteId: input.apiClienteId,
          externalId: input.externalId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          rampProfileId: input.rampProfileId,
          chain: input.chain,
          asset: input.asset,
          tokenContract: normalizeAddress(input.tokenContract),
          decimals: input.decimals,
          moedaFiat: input.moedaFiat,
          valorFiatCentavos: input.valorFiatCentavos,
          valorFiatUnidades: input.valorFiatUnidades,
          taxaTokenPorFiatBaseUnits: input.taxaTokenPorFiatBaseUnits,
          expectedBaseUnits: input.expectedBaseUnits,
          indiceHd: input.indiceHd,
          caminhoDerivacao: input.caminhoDerivacao,
          enderecoDeposito: normalizeAddress(input.enderecoDeposito),
          walletAddress: normalizeAddress(input.walletAddress),
          pageTokenHash: input.pageTokenHash,
          pageTokenEnc: this.seal(input.id, input.pageToken),
          rampUrl: input.rampUrl,
          status: input.status,
          expiraEm: input.expiraEm,
          liquidacaoAte: input.liquidacaoAte,
        })
        .returning();
      if (!row) throw new Error('falha ao criar link');
      await tx
        .update(hdIndices)
        .set({ linkId: row.id })
        .where(
          and(eq(hdIndices.scope, HD_INDEX_SCOPE), eq(hdIndices.indice, input.indiceHd)),
        );
      return this.hydrate(row);
    });
  }

  async findById(id: string): Promise<PaymentLink | null> {
    const [row] = await this.db
      .select()
      .from(linksGerados)
      .where(eq(linksGerados.id, id))
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  async findByDepositAddress(address: string): Promise<PaymentLink | null> {
    const [row] = await this.db
      .select()
      .from(linksGerados)
      .where(eq(linksGerados.enderecoDeposito, normalizeAddress(address)))
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  async findByPageTokenHash(hash: string): Promise<PaymentLink | null> {
    const [row] = await this.db
      .select()
      .from(linksGerados)
      .where(eq(linksGerados.pageTokenHash, hash))
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  async findByExternalId(apiClienteId: string, externalId: string): Promise<PaymentLink | null> {
    const [row] = await this.db
      .select()
      .from(linksGerados)
      .where(
        and(
          eq(linksGerados.apiClienteId, apiClienteId),
          eq(linksGerados.externalId, externalId),
        ),
      )
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  async findByIdempotencyKey(
    apiClienteId: string,
    idempotencyKey: string,
  ): Promise<PaymentLink | null> {
    const [row] = await this.db
      .select()
      .from(linksGerados)
      .where(
        and(
          eq(linksGerados.apiClienteId, apiClienteId),
          eq(linksGerados.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  async listByClient(apiClienteId: string, limit: number): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(linksGerados)
      .where(eq(linksGerados.apiClienteId, apiClienteId))
      .orderBy(desc(linksGerados.criadoEm))
      .limit(limit);
    return rows.map((row) => this.hydrate(row));
  }

  async listAll(limit: number): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(linksGerados)
      .orderBy(desc(linksGerados.criadoEm))
      .limit(limit);
    return rows.map((row) => this.hydrate(row));
  }

  async listByStatus(status: LinkStatus, limit: number): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(linksGerados)
      .where(eq(linksGerados.status, status))
      .orderBy(asc(linksGerados.criadoEm))
      .limit(limit);
    return rows.map((row) => this.hydrate(row));
  }

  async listExpiredPages(now: Date, limit: number): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(linksGerados)
      .where(and(eq(linksGerados.status, 'aguardando'), lte(linksGerados.expiraEm, now)))
      .orderBy(asc(linksGerados.expiraEm))
      .limit(limit);
    return rows.map((row) => this.hydrate(row));
  }

  async listDueSettlement(now: Date, limit: number): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(linksGerados)
      .where(
        and(
          inArray(linksGerados.status, ['expirado', 'parcial']),
          lte(linksGerados.liquidacaoAte, now),
        ),
      )
      .orderBy(asc(linksGerados.liquidacaoAte))
      .limit(limit);
    return rows.map((row) => this.hydrate(row));
  }

  async updateStatus(id: string, status: LinkStatus): Promise<void> {
    await this.db.update(linksGerados).set({ status }).where(eq(linksGerados.id, id));
  }

  async updateSettlement(id: string, patch: SettlementPatch): Promise<void> {
    const values: Partial<typeof linksGerados.$inferInsert> = {};
    if (patch.motivoNaoRealizado !== undefined) {
      values.motivoNaoRealizado = patch.motivoNaoRealizado;
    }
    if (patch.valorRecebidoBaseUnits !== undefined) {
      values.valorRecebidoBaseUnits = patch.valorRecebidoBaseUnits;
    }
    if (patch.reembolsado !== undefined) values.reembolsado = patch.reembolsado;
    if (Object.keys(values).length === 0) return;
    await this.db.update(linksGerados).set(values).where(eq(linksGerados.id, id));
  }

  async listDepositAddresses(statuses: LinkStatus[]): Promise<string[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select({ address: linksGerados.enderecoDeposito })
      .from(linksGerados)
      .where(inArray(linksGerados.status, statuses));
    return rows.map((r) => r.address);
  }

  async listTokenPairs(
    statuses: LinkStatus[],
  ): Promise<Array<{ chain: string; tokenContract: string }>> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .selectDistinct({
        chain: linksGerados.chain,
        tokenContract: linksGerados.tokenContract,
      })
      .from(linksGerados)
      .where(inArray(linksGerados.status, statuses));
    return rows.map((row) => ({
      chain: row.chain,
      tokenContract: row.tokenContract.toLowerCase(),
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

function toPayment(row: typeof linksPagos.$inferSelect): Payment {
  return {
    id: row.id,
    linkId: row.linkId,
    txHash: row.txHash.toLowerCase(),
    logIndex: row.logIndex,
    deAddress: checksumAddress(row.deAddress),
    paraAddress: checksumAddress(row.paraAddress),
    token: row.token,
    valorBaseUnits: row.valorBaseUnits,
    confirmacoes: row.confirmacoes,
    bloco: row.bloco,
    status: row.status as Payment['status'],
    detectadoEm: row.detectadoEm,
    confirmadoEm: row.confirmadoEm,
  };
}

class DrizzlePaymentRepository implements PaymentRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: UpsertPaymentInput): Promise<Payment> {
    const txHash = input.txHash.toLowerCase();
    const existing = await this.db
      .select()
      .from(linksPagos)
      .where(and(eq(linksPagos.txHash, txHash), eq(linksPagos.logIndex, input.logIndex)))
      .limit(1);

    if (existing.length > 0) {
      const row = existing[0]!;
      if (row.status === 'confirmado') return toPayment(row);

      const [updated] = await this.db
        .update(linksPagos)
        .set({
          status: input.status,
          bloco: input.bloco,
          valorBaseUnits: input.valorBaseUnits,
          deAddress: normalizeAddress(input.deAddress),
          paraAddress: normalizeAddress(input.paraAddress),
          token: input.token,
          detectadoEm: input.detectadoEm,
          confirmacoes: input.status === 'confirmado' ? row.confirmacoes : 0,
          confirmadoEm: input.status === 'confirmado' ? new Date() : null,
        })
        .where(eq(linksPagos.id, row.id))
        .returning();
      return toPayment(updated ?? row);
    }

    const [row] = await this.db
      .insert(linksPagos)
      .values({
        linkId: input.linkId,
        txHash,
        logIndex: input.logIndex,
        deAddress: normalizeAddress(input.deAddress),
        paraAddress: normalizeAddress(input.paraAddress),
        token: input.token,
        valorBaseUnits: input.valorBaseUnits,
        bloco: input.bloco,
        status: input.status,
        detectadoEm: input.detectadoEm,
        ...(input.status === 'confirmado' ? { confirmadoEm: new Date() } : {}),
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      const [again] = await this.db
        .select()
        .from(linksPagos)
        .where(and(eq(linksPagos.txHash, txHash), eq(linksPagos.logIndex, input.logIndex)))
        .limit(1);
      if (again) return toPayment(again);
      throw new Error('falha ao registrar pagamento');
    }
    return toPayment(row);
  }

  async confirm(input: { paymentId: string; confirmacoes: number }): Promise<Payment> {
    const [updated] = await this.db
      .update(linksPagos)
      .set({ status: 'confirmado', confirmadoEm: new Date(), confirmacoes: input.confirmacoes })
      .where(eq(linksPagos.id, input.paymentId))
      .returning();
    if (!updated) throw new Error(`pagamento nao encontrado: ${input.paymentId}`);
    return toPayment(updated);
  }

  async findByTxHash(txHash: string): Promise<Payment | null> {
    const [row] = await this.db
      .select()
      .from(linksPagos)
      .where(eq(linksPagos.txHash, txHash))
      .limit(1);
    return row ? toPayment(row) : null;
  }

  async listByLink(linkId: string): Promise<Payment[]> {
    const rows = await this.db
      .select()
      .from(linksPagos)
      .where(eq(linksPagos.linkId, linkId))
      .orderBy(asc(linksPagos.bloco));
    return rows.map(toPayment);
  }

  async listByStatus(status: Payment['status'], limit: number): Promise<Payment[]> {
    const rows = await this.db
      .select()
      .from(linksPagos)
      .where(eq(linksPagos.status, status))
      .orderBy(asc(linksPagos.bloco))
      .limit(limit);
    return rows.map(toPayment);
  }

  async listForReconciliation(limit: number): Promise<Payment[]> {
    const rows = await this.db
      .select({ p: linksPagos })
      .from(linksPagos)
      .innerJoin(linksGerados, eq(linksPagos.linkId, linksGerados.id))
      .where(
        and(
          eq(linksPagos.status, 'confirmado'),
          inArray(linksGerados.status, ['aguardando', 'expirado', 'parcial', 'nao_realizado']),
        ),
      )
      .orderBy(asc(linksPagos.bloco))
      .limit(limit);
    return rows.map((r) => toPayment(r.p));
  }

  async sumConfirmedByLink(linkId: string): Promise<bigint> {
    const [row] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${linksPagos.valorBaseUnits}), 0)::text`,
      })
      .from(linksPagos)
      .where(and(eq(linksPagos.linkId, linkId), eq(linksPagos.status, 'confirmado')));
    return toBigInt(row?.total);
  }

  async updateConfirmations(paymentId: string, confirmacoes: number): Promise<void> {
    await this.db
      .update(linksPagos)
      .set({ confirmacoes })
      .where(eq(linksPagos.id, paymentId));
  }

  async listConfirmedAboveBlock(chain: string, bloco: number): Promise<Payment[]> {
    const rows = await this.db
      .select({ p: linksPagos })
      .from(linksPagos)
      .innerJoin(linksGerados, eq(linksPagos.linkId, linksGerados.id))
      .where(
        and(
          eq(linksGerados.chain, chain),
          gt(linksPagos.bloco, bloco),
          inArray(linksPagos.status, ['detectado', 'confirmado']),
        ),
      );
    return rows.map((r) => toPayment(r.p));
  }

  async revertAboveBlock(chain: string, bloco: number): Promise<number> {
    const rows = await this.db
      .update(linksPagos)
      .set({ status: 'revertido', confirmadoEm: null, confirmacoes: 0 })
      .where(
        and(
          inArray(linksPagos.status, ['detectado', 'confirmado']),
          gt(linksPagos.bloco, bloco),
          inArray(
            linksPagos.linkId,
            this.db
              .select({ id: linksGerados.id })
              .from(linksGerados)
              .where(eq(linksGerados.chain, chain)),
          ),
        ),
      )
      .returning({ id: linksPagos.id });
    return rows.length;
  }
}

/* ------------------------------------------------------------------ */
/* Internal transfers (sweeps)                                         */
/* ------------------------------------------------------------------ */

function toTransfer(row: typeof movimentosInternos.$inferSelect): InternalTransfer {
  return {
    id: row.id,
    linkId: row.linkId,
    deAddress: checksumAddress(row.deAddress),
    paraAddress: row.paraAddress ? checksumAddress(row.paraAddress) : row.paraAddress,
    valorBaseUnits: row.valorBaseUnits,
    txHash: row.txHash ? row.txHash.toLowerCase() : null,
    status: row.status as TransferStatus,
    erro: row.erro,
    chain: row.chain,
    bloco: row.bloco,
    nonce: row.nonce,
    kind: row.kind as TransferKind,
    rawTransaction: row.rawTransaction,
    unsignedTransaction: row.unsignedTransaction,
    criadoEm: row.criadoEm,
  };
}

class DrizzleTransferRepository implements TransferRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateTransferInput): Promise<InternalTransfer> {
    const [row] = await this.db
      .insert(movimentosInternos)
      .values({
        linkId: input.linkId,
        deAddress: normalizeAddress(input.deAddress),
        paraAddress: input.paraAddress ? normalizeAddress(input.paraAddress) : '',
        valorBaseUnits: input.valorBaseUnits,
        txHash: input.txHash ? input.txHash.toLowerCase() : null,
        status: input.status,
        erro: input.erro ?? null,
        chain: input.chain,
        bloco: input.bloco ?? null,
        nonce: input.nonce ?? null,
        kind: input.kind ?? 'sweep',
        rawTransaction: input.rawTransaction ?? null,
        unsignedTransaction: input.unsignedTransaction ?? null,
      })
      .returning();
    if (!row) throw new Error('falha ao registrar movimento interno');
    return toTransfer(row);
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
    await this.db
      .update(movimentosInternos)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.txHash !== undefined
          ? { txHash: patch.txHash ? patch.txHash.toLowerCase() : patch.txHash }
          : {}),
        ...(patch.erro !== undefined ? { erro: patch.erro } : {}),
        ...(patch.valorBaseUnits !== undefined
          ? { valorBaseUnits: patch.valorBaseUnits }
          : {}),
        ...(patch.paraAddress !== undefined
          ? {
              paraAddress: patch.paraAddress
                ? normalizeAddress(patch.paraAddress)
                : patch.paraAddress,
            }
          : {}),
        ...(patch.bloco !== undefined ? { bloco: patch.bloco } : {}),
        ...(patch.rawTransaction !== undefined
          ? { rawTransaction: patch.rawTransaction }
          : {}),
        ...(patch.unsignedTransaction !== undefined
          ? { unsignedTransaction: patch.unsignedTransaction }
          : {}),
      })
      .where(eq(movimentosInternos.id, id));
  }

  async existsByNonce(linkId: string, nonce: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: movimentosInternos.id })
      .from(movimentosInternos)
      .where(and(eq(movimentosInternos.linkId, linkId), eq(movimentosInternos.nonce, nonce)))
      .limit(1);
    return Boolean(row);
  }

  async findByLinkKindNonce(
    linkId: string,
    kind: TransferKind,
    nonce: number,
  ): Promise<InternalTransfer | null> {
    const [row] = await this.db
      .select()
      .from(movimentosInternos)
      .where(
        and(
          eq(movimentosInternos.linkId, linkId),
          eq(movimentosInternos.kind, kind),
          eq(movimentosInternos.nonce, nonce),
        ),
      )
      .limit(1);
    return row ? toTransfer(row) : null;
  }

  async listInFlight(limit: number): Promise<InternalTransfer[]> {
    const rows = await this.db
      .select()
      .from(movimentosInternos)
      .where(
        and(
          inArray(movimentosInternos.status, ['pendente', 'patrocinado', 'enviado']),
          or(
            isNotNull(movimentosInternos.rawTransaction),
            isNotNull(movimentosInternos.txHash),
          ),
        ),
      )
      .orderBy(asc(movimentosInternos.criadoEm))
      .limit(limit);
    return rows.map(toTransfer);
  }

  async revertAboveBlock(chain: string, bloco: number): Promise<number> {
    const rows = await this.db
      .update(movimentosInternos)
      .set({
        status: 'pendente',
        txHash: null,
        rawTransaction: null,
        unsignedTransaction: null,
        bloco: null,
        erro: 'reorg: refazer sweep',
      })
      .where(
        and(
          eq(movimentosInternos.chain, chain),
          gt(movimentosInternos.bloco, bloco),
          inArray(movimentosInternos.status, ['enviado', 'confirmado', 'patrocinado']),
        ),
      )
      .returning({ id: movimentosInternos.id });
    return rows.length;
  }

  async findById(id: string): Promise<InternalTransfer | null> {
    const [row] = await this.db
      .select()
      .from(movimentosInternos)
      .where(eq(movimentosInternos.id, id))
      .limit(1);
    return row ? toTransfer(row) : null;
  }

  async findByLink(linkId: string): Promise<InternalTransfer[]> {
    const rows = await this.db
      .select()
      .from(movimentosInternos)
      .where(eq(movimentosInternos.linkId, linkId))
      .orderBy(asc(movimentosInternos.criadoEm));
    return rows.map(toTransfer);
  }

  async listByStatus(status: TransferStatus, limit: number): Promise<InternalTransfer[]> {
    const rows = await this.db
      .select()
      .from(movimentosInternos)
      .where(eq(movimentosInternos.status, status))
      .orderBy(asc(movimentosInternos.criadoEm))
      .limit(limit);
    return rows.map(toTransfer);
  }
}

/* ------------------------------------------------------------------ */
/* Webhook outbox                                                      */
/* ------------------------------------------------------------------ */

function toWebhookEvent(row: typeof webhookOutbox.$inferSelect): WebhookEvent {
  return {
    id: row.id,
    apiClienteId: row.apiClienteId,
    linkId: row.linkId,
    eventType: row.eventType as WebhookEventType,
    payload: row.payload,
    status: row.status as WebhookStatus,
    attempts: row.attempts,
    nextAttemptEm: row.nextAttemptEm,
    lastError: row.lastError,
    deliveredEm: row.deliveredEm,
    criadoEm: row.criadoEm,
  };
}

class DrizzleWebhookOutboxRepository implements WebhookOutboxRepository {
  constructor(private readonly db: Database) {}

  async enqueue(input: CreateWebhookEventInput): Promise<WebhookEvent | null> {
    const [row] = await this.db
      .insert(webhookOutbox)
      .values({
        apiClienteId: input.apiClienteId,
        linkId: input.linkId,
        eventType: input.eventType,
        payload: input.payload,
        nextAttemptEm: input.nextAttemptEm,
      })
      .onConflictDoNothing()
      .returning();
    return row ? toWebhookEvent(row) : null;
  }

  async findById(id: string): Promise<WebhookEvent | null> {
    const [row] = await this.db
      .select()
      .from(webhookOutbox)
      .where(eq(webhookOutbox.id, id))
      .limit(1);
    return row ? toWebhookEvent(row) : null;
  }

  async listDue(now: Date, limit: number): Promise<WebhookEvent[]> {
    const rows = await this.db
      .select()
      .from(webhookOutbox)
      .where(
        and(
          eq(webhookOutbox.status, 'pendente'),
          lte(webhookOutbox.nextAttemptEm, now),
        ),
      )
      .orderBy(asc(webhookOutbox.nextAttemptEm))
      .limit(limit);
    return rows.map(toWebhookEvent);
  }

  async listByLink(linkId: string): Promise<WebhookEvent[]> {
    const rows = await this.db
      .select()
      .from(webhookOutbox)
      .where(eq(webhookOutbox.linkId, linkId))
      .orderBy(asc(webhookOutbox.criadoEm));
    return rows.map(toWebhookEvent);
  }

  async listAll(limit: number): Promise<WebhookEvent[]> {
    const rows = await this.db
      .select()
      .from(webhookOutbox)
      .orderBy(desc(webhookOutbox.criadoEm))
      .limit(limit);
    return rows.map(toWebhookEvent);
  }

  async markDelivered(id: string): Promise<void> {
    await this.db
      .update(webhookOutbox)
      .set({ status: 'entregue', deliveredEm: new Date(), lastError: null })
      .where(eq(webhookOutbox.id, id));
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
    await this.db
      .update(webhookOutbox)
      .set({
        attempts: input.attempts,
        nextAttemptEm: input.nextAttemptEm,
        lastError: input.lastError.slice(0, 1_000),
        status: input.status ?? 'pendente',
      })
      .where(eq(webhookOutbox.id, id));
  }

  async replay(id: string, now: Date): Promise<WebhookEvent | null> {
    const [row] = await this.db
      .update(webhookOutbox)
      .set({
        status: 'pendente',
        attempts: 0,
        nextAttemptEm: now,
        lastError: null,
        deliveredEm: null,
      })
      .where(eq(webhookOutbox.id, id))
      .returning();
    return row ? toWebhookEvent(row) : null;
  }
}

/* ------------------------------------------------------------------ */
/* Cursors + anchors + HD indices                                      */
/* ------------------------------------------------------------------ */

class DrizzleCursorRepository implements CursorRepository {
  constructor(private readonly db: Database) {}

  async get(chain: string, tokenContract: string): Promise<ChainCursor | null> {
    const [row] = await this.db
      .select()
      .from(chainCursors)
      .where(
        and(
          eq(chainCursors.chain, chain),
          eq(chainCursors.tokenContract, tokenContract.toLowerCase()),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      chain: row.chain,
      tokenContract: row.tokenContract,
      ultimoBloco: row.ultimoBloco,
      hashBloco: row.hashBloco,
    };
  }

  async set(
    chain: string,
    tokenContract: string,
    bloco: number,
    hashBloco: string | null,
  ): Promise<void> {
    const key = tokenContract.toLowerCase();
    await this.db
      .insert(chainCursors)
      .values({ chain, tokenContract: key, ultimoBloco: bloco, hashBloco })
      .onConflictDoUpdate({
        target: [chainCursors.chain, chainCursors.tokenContract],
        set: { ultimoBloco: bloco, hashBloco, atualizadoEm: new Date() },
      });
  }

  async rewind(
    chain: string,
    tokenContract: string,
    bloco: number,
    hashBloco: string | null,
  ): Promise<void> {
    await this.db
      .update(chainCursors)
      .set({ ultimoBloco: bloco, hashBloco, atualizadoEm: new Date() })
      .where(
        and(
          eq(chainCursors.chain, chain),
          eq(chainCursors.tokenContract, tokenContract.toLowerCase()),
        ),
      );
  }
}

class DrizzleAnchorRepository implements AnchorRepository {
  constructor(private readonly db: Database) {}

  async record(anchor: ChainAnchor): Promise<void> {
    await this.db
      .insert(chainAnchors)
      .values({
        chain: anchor.chain,
        tokenContract: anchor.tokenContract.toLowerCase(),
        bloco: anchor.bloco,
        hashBloco: anchor.hashBloco,
      })
      .onConflictDoNothing();
  }

  async list(chain: string, tokenContract: string, limit: number): Promise<ChainAnchor[]> {
    const rows = await this.db
      .select()
      .from(chainAnchors)
      .where(
        and(
          eq(chainAnchors.chain, chain),
          eq(chainAnchors.tokenContract, tokenContract.toLowerCase()),
        ),
      )
      .orderBy(desc(chainAnchors.bloco))
      .limit(limit);
    return rows.map((r) => ({
      chain: r.chain,
      tokenContract: r.tokenContract,
      bloco: r.bloco,
      hashBloco: r.hashBloco,
    }));
  }

  async pruneAfter(chain: string, tokenContract: string, bloco: number): Promise<void> {
    await this.db
      .delete(chainAnchors)
      .where(
        and(
          eq(chainAnchors.chain, chain),
          eq(chainAnchors.tokenContract, tokenContract.toLowerCase()),
          gt(chainAnchors.bloco, bloco),
        ),
      );
  }

  async oldest(chain: string, tokenContract: string): Promise<ChainAnchor | null> {
    const [row] = await this.db
      .select()
      .from(chainAnchors)
      .where(
        and(
          eq(chainAnchors.chain, chain),
          eq(chainAnchors.tokenContract, tokenContract.toLowerCase()),
        ),
      )
      .orderBy(asc(chainAnchors.bloco))
      .limit(1);
    return row
      ? {
          chain: row.chain,
          tokenContract: row.tokenContract,
          bloco: row.bloco,
          hashBloco: row.hashBloco,
        }
      : null;
  }
}

class DrizzleIndexAllocator implements IndexAllocator {
  constructor(private readonly db: Database) {}

  async allocate(scope: string, maxIndex?: number): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope}))`);
          const [row] = await tx
            .select({
              next: sql<string>`coalesce(max(${hdIndices.indice}) + 1, 0)::text`,
            })
            .from(hdIndices);
          const next = toNumber(row?.next);
          if (maxIndex !== undefined && next > maxIndex) {
            throw new Error(
              `limite de indices HD atingido: proximo=${next}, maximo=${maxIndex}`,
            );
          }
          await tx.insert(hdIndices).values({ scope, indice: next });
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('duplicate key') && attempt < 4) continue;
        throw err;
      }
    }
    throw new Error('nao foi possivel alocar indice HD apos 5 tentativas');
  }

  async release(scope: string, indice: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope}))`);
      await tx
        .delete(hdIndices)
        .where(
          and(
            eq(hdIndices.scope, scope),
            eq(hdIndices.indice, indice),
            isNull(hdIndices.linkId),
          ),
        );
    });
  }
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

class DrizzleAuditRepository implements AuditRepository {
  constructor(private readonly db: Database) {}

  async record(input: RecordAuditInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK_ID})`);

      const [last] = await tx
        .select({
          hash: eventosAuditoria.hash,
          criadoEm: eventosAuditoria.criadoEm,
        })
        .from(eventosAuditoria)
        .orderBy(desc(eventosAuditoria.criadoEm), desc(eventosAuditoria.id))
        .limit(1);
      const hashAnterior = last?.hash ?? null;
      const now = new Date();
      const criadoEm =
        last?.criadoEm && now.getTime() <= last.criadoEm.getTime()
          ? new Date(last.criadoEm.getTime() + 1)
          : now;
      const id = randomUUID();
      const detalhes = input.detalhes ? JSON.stringify(input.detalhes) : null;
      const hash = createHash('sha256')
        .update(
          canonicalAuditPreimage([
            hashAnterior ?? '',
            id,
            criadoEm.toISOString(),
            input.ator,
            input.acao,
            input.entidade,
            input.entidadeId ?? '',
            input.ip ?? '',
            detalhes ?? '',
          ]),
        )
        .digest('hex');

      await tx.insert(eventosAuditoria).values({
        id,
        ator: input.ator,
        acao: input.acao,
        entidade: input.entidade,
        entidadeId: input.entidadeId ?? null,
        detalhes,
        ip: input.ip ?? null,
        hashAnterior,
        hash,
        criadoEm,
      });
    });
  }

  async list(limit: number): Promise<AuditEvent[]> {
    const rows = await this.db
      .select()
      .from(eventosAuditoria)
      .orderBy(desc(eventosAuditoria.criadoEm))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      ator: row.ator,
      acao: row.acao,
      entidade: row.entidade,
      entidadeId: row.entidadeId,
      detalhes: row.detalhes ? (JSON.parse(row.detalhes) as Record<string, unknown>) : null,
      ip: row.ip,
      criadoEm: row.criadoEm,
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createRepositories(
  db: Database,
  cipher: DataCipher | null = null,
): MotorRepositories {
  return {
    apiClients: new DrizzleApiClientRepository(db, cipher),
    apiClientWallets: new DrizzleApiClientWalletRepository(db),
    nonces: new DrizzleNonceRepository(db),
    rampProfiles: new DrizzleRampProfileRepository(db, cipher),
    links: new DrizzleLinkRepository(db, cipher),
    payments: new DrizzlePaymentRepository(db),
    transfers: new DrizzleTransferRepository(db),
    webhooks: new DrizzleWebhookOutboxRepository(db),
    cursors: new DrizzleCursorRepository(db),
    anchors: new DrizzleAnchorRepository(db),
    indices: new DrizzleIndexAllocator(db),
    audit: new DrizzleAuditRepository(db),
  };
}

/** Exportado para testes de contrato que precisam hashear uma API key. */
export { sha256Hex };
