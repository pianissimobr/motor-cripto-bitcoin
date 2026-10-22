import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { checksumAddress, normalizeAddress } from '../../core/domain/address.js';
import { HD_INDEX_SCOPE } from '../../core/hd/index-scope.js';
import type { Database } from './client.js';
import {
  cadastrosPrefixos,
  cadastros,
  cadastrosLinks,
  carteirasFrias,
  chainAnchors,
  chainCursors,
  creditosCliente,
  eventosAuditoria,
  hdIndices,
  linksGerados,
  linksPagos,
  movimentosInternos,
  rampProfiles,
} from './schema.js';
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
} from '../../core/ports/index.js';
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
} from '../../core/domain/types.js';

/**
 * Implementacao dos ports do motor sobre Drizzle/Postgres.
 *
 * Os blobs cifrados sao gravados como base64 em colunas text (portavel
 * entre drivers). O conteudo em claro nunca chega nesta camada.
 */

/** A3: lock de serializacao da cadeia de auditoria (escopo global do banco). */
const AUDIT_LOCK_ID = 7_315_902_411;

const enc = (buf: Buffer): string => buf.toString('base64');
const dec = (value: string): Buffer => Buffer.from(value, 'base64');

/**
 * O driver `postgres.js` devolve `numeric`/`bigint` do Postgres como string
 * (mesmo para `sum(integer)` e `count(*)`). Sem a conversao explicita,
 * `total <= 0n` compara string com bigint e lanca em runtime.
 */
function toBigInt(value: bigint | string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

function toNumber(value: bigint | string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

function toStoredCustomer(row: typeof cadastros.$inferSelect): StoredCustomer {
  return {
    id: row.id,
    nomeEnc: dec(row.nomeEnc),
    emailEnc: dec(row.emailEnc),
    emailBidx: row.emailBidxV2 ?? row.emailBidx,
    emailBidxAnterior: row.emailBidxV2 ? row.emailBidx : null,
    nomeMasked: row.nomeMasked,
    emailMasked: row.emailMasked,
    status: row.status as CustomerStatus,
    criadoEm: row.criadoEm,
  };
}

class DrizzleCustomerRepository implements CustomerRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateCustomerInput): Promise<StoredCustomer> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(cadastros)
        .values({
          id: input.id,
          nomeEnc: enc(input.nomeEnc),
          emailEnc: enc(input.emailEnc),
          emailBidx: input.emailBidx,
          emailBidxV2: input.emailBidxV2,
          nomeMasked: input.nomeMasked,
          emailMasked: input.emailMasked,
          status: input.status ?? 'ativo',
        })
        .returning();
      if (!row) throw new Error('falha ao inserir cadastro');

      const prefixos = [
        ...input.prefixBidxList.map((prefixBidx) => ({ prefixBidx, prefixBidxV2: null })),
        ...input.prefixBidxListV2.map((prefixBidx) => ({
          prefixBidx: `v2:${prefixBidx}`,
          prefixBidxV2: prefixBidx,
        })),
      ];
      if (prefixos.length > 0) {
        await tx
          .insert(cadastrosPrefixos)
          .values(prefixos.map((p) => ({ ...p, clienteId: input.id })))
          .onConflictDoNothing();
      }
      return toStoredCustomer(row);
    });
  }

  async findById(id: string): Promise<StoredCustomer | null> {
    const [row] = await this.db.select().from(cadastros).where(eq(cadastros.id, id)).limit(1);
    return row ? toStoredCustomer(row) : null;
  }

  /**
   * E3: busca exata tolerante a rotacao.
   *
   * Consulta as DUAS colunas (ativa e anterior) em vez de `coalesce`:
   * durante a transicao o indice procurado pode ser o novo enquanto a linha
   * ainda guarda o antigo em `email_bidx` (e vice-versa).
   */
  async findByEmailBidx(emailBidxes: string[]): Promise<StoredCustomer | null> {
    if (emailBidxes.length === 0) return null;
    const [row] = await this.db
      .select()
      .from(cadastros)
      .where(
        or(
          inArray(cadastros.emailBidxV2, emailBidxes),
          inArray(cadastros.emailBidx, emailBidxes),
        ),
      )
      .limit(1);
    return row ? toStoredCustomer(row) : null;
  }

  async searchByEmailPrefixBidx(
    prefixBidxes: string[],
    limit: number,
  ): Promise<StoredCustomer[]> {
    if (prefixBidxes.length === 0) return [];
    // Os tokens v2 sao gravados com prefixo "v2:" para nao colidir no PK.
    const chaves = [
      ...prefixBidxes.map((b) => b),
      ...prefixBidxes.map((b) => `v2:${b}`),
    ];
    const rows = await this.db
      .select({ c: cadastros })
      .from(cadastrosPrefixos)
      .innerJoin(cadastros, eq(cadastrosPrefixos.clienteId, cadastros.id))
      .where(inArray(cadastrosPrefixos.prefixBidx, chaves))
      .orderBy(asc(cadastros.criadoEm))
      .limit(limit);
    const vistos = new Set<string>();
    const saida: StoredCustomer[] = [];
    for (const r of rows) {
      if (vistos.has(r.c.id)) continue;
      vistos.add(r.c.id);
      saida.push(toStoredCustomer(r.c));
    }
    return saida;
  }

  /** E4: pagina por id para a re-cifragem em lote. */
  async listAllForRotation(afterId: string | null, limit: number): Promise<StoredCustomer[]> {
    const rows = afterId
      ? await this.db
          .select()
          .from(cadastros)
          .where(gt(cadastros.id, afterId))
          .orderBy(asc(cadastros.id))
          .limit(limit)
      : await this.db
          .select()
          .from(cadastros)
          .orderBy(asc(cadastros.id))
          .limit(limit);
    return rows.map(toStoredCustomer);
  }

  /** E4: regrava os blobs e os indices. */
  async updateEncrypted(
    id: string,
    nomeEnc: Buffer,
    emailEnc: Buffer,
    emailBidx: string,
    emailBidxV2: string | null,
    prefixBidxList: string[],
    prefixBidxListV2: string[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(cadastros)
        .set({ nomeEnc: enc(nomeEnc), emailEnc: enc(emailEnc), emailBidx, emailBidxV2 })
        .where(eq(cadastros.id, id));

      await tx.delete(cadastrosPrefixos).where(eq(cadastrosPrefixos.clienteId, id));
      const prefixos = [
        ...prefixBidxList.map((prefixBidx) => ({ prefixBidx, prefixBidxV2: null })),
        ...prefixBidxListV2.map((prefixBidx) => ({
          prefixBidx: `v2:${prefixBidx}`,
          prefixBidxV2: prefixBidx,
        })),
      ];
      if (prefixos.length > 0) {
        await tx
          .insert(cadastrosPrefixos)
          .values(prefixos.map((p) => ({ ...p, clienteId: id })))
          .onConflictDoNothing();
      }
    });
  }

  async list(limit: number, offset: number): Promise<StoredCustomer[]> {
    const rows = await this.db
      .select()
      .from(cadastros)
      .orderBy(desc(cadastros.criadoEm))
      .limit(limit)
      .offset(offset);
    return rows.map(toStoredCustomer);
  }

  async count(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(cadastros);
    return toNumber(row?.n);
  }
}

/* ------------------------------------------------------------------ */
/* Ramp profiles                                                       */
/* ------------------------------------------------------------------ */

function toRampProfile(row: typeof rampProfiles.$inferSelect): RampProfile {
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
    hostApiKey: row.hostApiKeyEnc,
    taxaTokenPorFiatBaseUnits: row.taxaTokenPorFiatBaseUnits,
    rampAssetKey: row.rampAssetKey,
    criadoEm: row.criadoEm,
  };
}

class DrizzleRampProfileRepository implements RampProfileRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateRampProfileInput): Promise<RampProfile> {
    const [row] = await this.db
      .insert(rampProfiles)
      .values({
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
        hostApiKeyEnc: input.hostApiKey ?? null,
        rampAssetKey: input.rampAssetKey ?? null,
        taxaTokenPorFiatBaseUnits: input.taxaTokenPorFiatBaseUnits ?? null,
      })
      .returning();
    if (!row) throw new Error('falha ao criar perfil Ramp');
    return toRampProfile(row);
  }

  async findById(id: string): Promise<RampProfile | null> {
    const [row] = await this.db
      .select()
      .from(rampProfiles)
      .where(eq(rampProfiles.id, id))
      .limit(1);
    return row ? toRampProfile(row) : null;
  }

  async list(): Promise<RampProfile[]> {
    const rows = await this.db
      .select()
      .from(rampProfiles)
      .orderBy(asc(rampProfiles.label));
    return rows.map(toRampProfile);
  }
}

/* ------------------------------------------------------------------ */
/* Cold wallets                                                        */
/* ------------------------------------------------------------------ */

function toColdWallet(row: typeof carteirasFrias.$inferSelect): ColdWallet {
  return {
    id: row.id,
    label: row.label,
    // Armazenado lowercase; exibido em checksum EIP-55.
    address: checksumAddress(row.address),
    chain: row.chain,
    criadoEm: row.criadoEm,
  };
}

class DrizzleColdWalletRepository implements ColdWalletRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateColdWalletInput): Promise<ColdWallet> {
    const [row] = await this.db
      .insert(carteirasFrias)
      .values({
        label: input.label,
        address: normalizeAddress(input.address),
        chain: input.chain.toLowerCase(),
      })
      .returning();
    if (!row) throw new Error('falha ao criar carteira fria');
    return toColdWallet(row);
  }

  async findById(id: string): Promise<ColdWallet | null> {
    const [row] = await this.db
      .select()
      .from(carteirasFrias)
      .where(eq(carteirasFrias.id, id))
      .limit(1);
    return row ? toColdWallet(row) : null;
  }

  async findByAddress(address: string): Promise<ColdWallet | null> {
    const [row] = await this.db
      .select()
      .from(carteirasFrias)
      .where(eq(carteirasFrias.address, normalizeAddress(address)))
      .limit(1);
    return row ? toColdWallet(row) : null;
  }

  async list(): Promise<ColdWallet[]> {
    const rows = await this.db
      .select()
      .from(carteirasFrias)
      .orderBy(asc(carteirasFrias.label));
    return rows.map(toColdWallet);
  }
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

function toPaymentLink(row: typeof linksGerados.$inferSelect): PaymentLink {
  return {
    id: row.id,
    clienteId: row.clienteId,
    rampProfileId: row.rampProfileId,
    chain: row.chain,
    asset: row.asset,
    decimals: row.decimals,
    moedaFiat: row.moedaFiat,
    valorFiatCentavos: row.valorFiatCentavos,
    valorFiatUnidades: row.valorFiatUnidades,
    taxaTokenPorFiatBaseUnits: row.taxaTokenPorFiatBaseUnits,
    expectedBaseUnits: row.expectedBaseUnits,
    indiceHd: row.indiceHd,
    caminhoDerivacao: row.caminhoDerivacao,
    // Armazenado lowercase; exibido em checksum EIP-55.
    enderecoDeposito: checksumAddress(row.enderecoDeposito),
    carteiraFriaId: row.carteiraFriaId,
    carteiraFriaEndereco: row.carteiraFriaEndereco
      ? checksumAddress(row.carteiraFriaEndereco)
      : null,
    tokenContract: row.tokenContract.toLowerCase(),
    rampUrl: row.rampUrl,
    status: row.status as LinkStatus,
    expiraEm: row.expiraEm,
    criadoEm: row.criadoEm,
  };
}

class DrizzleLinkRepository implements LinkRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(linksGerados)
        .values({
          clienteId: input.clienteId,
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
          carteiraFriaId: input.carteiraFriaId,
          carteiraFriaEndereco: input.carteiraFriaEndereco
            ? normalizeAddress(input.carteiraFriaEndereco)
            : null,
          rampUrl: input.rampUrl,
          status: input.status,
          expiraEm: input.expiraEm,
        })
        .returning();
      if (!row) throw new Error('falha ao criar link');
      await tx.insert(cadastrosLinks).values({
        clienteId: input.clienteId,
        linkId: row.id,
      });
      await tx
        .update(hdIndices)
        .set({ linkId: row.id })
        .where(
          and(
            eq(hdIndices.scope, HD_INDEX_SCOPE),
            eq(hdIndices.indice, input.indiceHd),
          ),
        );
      return toPaymentLink(row);
    });
  }

  async findById(id: string): Promise<PaymentLink | null> {
    const [row] = await this.db
      .select()
      .from(linksGerados)
      .where(eq(linksGerados.id, id))
      .limit(1);
    return row ? toPaymentLink(row) : null;
  }

  async findByDepositAddress(address: string): Promise<PaymentLink | null> {
    const [row] = await this.db
      .select()
      .from(linksGerados)
      .where(eq(linksGerados.enderecoDeposito, normalizeAddress(address)))
      .limit(1);
    return row ? toPaymentLink(row) : null;
  }

  async listByCustomer(clienteId: string): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(linksGerados)
      .where(eq(linksGerados.clienteId, clienteId))
      .orderBy(desc(linksGerados.criadoEm));
    return rows.map(toPaymentLink);
  }

  async listAll(limit: number): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(linksGerados)
      .orderBy(desc(linksGerados.criadoEm))
      .limit(limit);
    return rows.map(toPaymentLink);
  }

  async listByStatus(status: LinkStatus, limit: number): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(linksGerados)
      .where(eq(linksGerados.status, status))
      .orderBy(asc(linksGerados.criadoEm))
      .limit(limit);
    return rows.map(toPaymentLink);
  }

  async updateStatus(id: string, status: LinkStatus): Promise<void> {
    await this.db
      .update(linksGerados)
      .set({ status })
      .where(eq(linksGerados.id, id));
  }

  async listDepositAddresses(statuses: LinkStatus[]): Promise<string[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select({ address: linksGerados.enderecoDeposito })
      .from(linksGerados)
      .where(inArray(linksGerados.status, statuses));
    return rows.map((r) => r.address);
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
      // Pagamento ja confirmado nao e reescrito por uma varredura normal;
      // reorgs passam por revertAboveBlock antes de a regiao ser relida.
      if (row.status === 'confirmado') return toPayment(row);

      // Re-deteccao (inclusive depois de um reorg) precisa atualizar o
      // bloco e os dados on-chain. Antes o registro ficava preso no bloco
      // antigo e a nova confirmacao calculava errado.
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

  /**
   * Confirma o pagamento e cria o credito NA MESMA transacao.
   *
   * Separar as duas escritas abria uma janela em que um crash deixava o
   * pagamento confirmado sem credito (dinheiro do cliente preso). O
   * `onConflictDoNothing` do credito mantem a operacao idempotente.
   */
  async confirm(input: {
    paymentId: string;
    confirmacoes: number;
    credit: CreateCreditInput | null;
  }): Promise<{ payment: Payment; creditCreated: boolean }> {
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(linksPagos)
        .set({ status: 'confirmado', confirmadoEm: new Date(), confirmacoes: input.confirmacoes })
        .where(eq(linksPagos.id, input.paymentId))
        .returning();
      if (!updated) throw new Error(`pagamento nao encontrado: ${input.paymentId}`);

      let creditCreated = false;
      if (input.credit) {
        const inserted = await tx
          .insert(creditosCliente)
          .values({
            clienteId: input.credit.clienteId,
            linkId: input.credit.linkId,
            pagamentoId: input.credit.pagamentoId,
            valorBaseUnits: input.credit.valorBaseUnits,
            valorCentavos: input.credit.valorCentavos,
            moeda: input.credit.moeda,
            status: input.credit.status,
          })
          .onConflictDoNothing()
          .returning({ id: creditosCliente.id });
        creditCreated = inserted.length > 0;
        if (!creditCreated) {
          // Reorg seguido de nova inclusao: o credito existe, mas foi
          // marcado como revertido. Restaura-lo e tao importante quanto
          // criar; sem isso o pagamento confirma e o cliente fica sem saldo.
          await tx
            .update(creditosCliente)
            .set({
              status: input.credit.status,
              valorBaseUnits: input.credit.valorBaseUnits,
              valorCentavos: input.credit.valorCentavos,
              moeda: input.credit.moeda,
            })
            .where(
              and(
                eq(creditosCliente.pagamentoId, input.credit.pagamentoId),
                eq(creditosCliente.status, 'revertido'),
              ),
            );
        }
      }

      return { payment: toPayment(updated), creditCreated };
    });
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

  /**
   * Confirmados cujo credito nao foi criado OU cujo link nao chegou ao
   * status final. Cobre o crash entre a confirmacao e a transicao/credito.
   */
  async listForReconciliation(limit: number): Promise<Payment[]> {
    const rows = await this.db
      .select({ p: linksPagos })
      .from(linksPagos)
      .innerJoin(linksGerados, eq(linksPagos.linkId, linksGerados.id))
      .leftJoin(creditosCliente, eq(creditosCliente.pagamentoId, linksPagos.id))
      .where(
        and(
          eq(linksPagos.status, 'confirmado'),
          or(
            isNull(creditosCliente.id),
            notInArray(linksGerados.status, ['pago', 'parcial', 'pago_sem_gas', 'movido']),
          ),
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

  /** C4: pagamentos cujo bloco caiu no reorg (na regiao descartada). */
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
/* Credits                                                             */
/* ------------------------------------------------------------------ */

function toCredit(row: typeof creditosCliente.$inferSelect): CustomerCredit {
  return {
    id: row.id,
    clienteId: row.clienteId,
    linkId: row.linkId,
    pagamentoId: row.pagamentoId,
    valorBaseUnits: row.valorBaseUnits,
    valorCentavos: row.valorCentavos,
    moeda: row.moeda,
    status: row.status as CreditStatus,
    criadoEm: row.criadoEm,
  };
}

class DrizzleCreditRepository implements CreditRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateCreditInput): Promise<CustomerCredit> {
    const [row] = await this.db
      .insert(creditosCliente)
      .values({
        clienteId: input.clienteId,
        linkId: input.linkId,
        pagamentoId: input.pagamentoId,
        valorBaseUnits: input.valorBaseUnits,
        valorCentavos: input.valorCentavos,
        moeda: input.moeda,
        status: input.status,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return toCredit(row);
    const existing = await this.findByPayment(input.pagamentoId);
    if (existing) return existing;
    throw new Error('falha ao creditar cliente');
  }

  async listByCustomer(clienteId: string): Promise<CustomerCredit[]> {
    const rows = await this.db
      .select()
      .from(creditosCliente)
      .where(eq(creditosCliente.clienteId, clienteId))
      .orderBy(desc(creditosCliente.criadoEm));
    return rows.map(toCredit);
  }

  async listAll(limit: number): Promise<CustomerCredit[]> {
    const rows = await this.db
      .select()
      .from(creditosCliente)
      .orderBy(desc(creditosCliente.criadoEm))
      .limit(limit);
    return rows.map(toCredit);
  }

  async sumByCustomer(clienteId: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${creditosCliente.valorCentavos}), 0)::text`,
      })
      .from(creditosCliente)
      .where(
        and(eq(creditosCliente.clienteId, clienteId), eq(creditosCliente.status, 'liberado')),
      );
    return toNumber(row?.total);
  }

  async findByPayment(pagamentoId: string): Promise<CustomerCredit | null> {
    const [row] = await this.db
      .select()
      .from(creditosCliente)
      .where(eq(creditosCliente.pagamentoId, pagamentoId))
      .limit(1);
    return row ? toCredit(row) : null;
  }

  /** C4: credito de pagamento revertido por reorg deixa de valer. */
  async revertByPaymentIds(pagamentoIds: string[]): Promise<number> {
    if (pagamentoIds.length === 0) return 0;
    const rows = await this.db
      .update(creditosCliente)
      .set({ status: 'revertido' })
      .where(
        and(
          inArray(creditosCliente.pagamentoId, pagamentoIds),
          inArray(creditosCliente.status, ['pendente', 'liberado']),
        ),
      )
      .returning({ id: creditosCliente.id });
    return rows.length;
  }

  async restoreByPaymentIds(
    pagamentoIds: string[],
    status: CreditStatus,
  ): Promise<number> {
    if (pagamentoIds.length === 0) return 0;
    const rows = await this.db
      .update(creditosCliente)
      .set({ status })
      .where(
        and(
          inArray(creditosCliente.pagamentoId, pagamentoIds),
          eq(creditosCliente.status, 'revertido'),
        ),
      )
      .returning({ id: creditosCliente.id });
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

  /** D4: existe sweep registrado para este (link, nonce)? */
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

  /** C5: um sweep cujo bloco caiu no reorg precisa ser refeito. */
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
/* Cursors + HD indices                                                */
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

  /** C3: rebobina o cursor apos um reorg. */
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

/**
 * Alocacao atomica de indice HD.
 *
 * Um endereco derivado e publico: reutilizar o mesmo indice poderia receber
 * fundos de um link antigo. Por isso o indice e unico por escopo e a
 * alocacao serializa com um advisory lock de transacao.
 */
class DrizzleIndexAllocator implements IndexAllocator {
  constructor(private readonly db: Database) {}

  async allocate(scope: string, maxIndex?: number): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          // Lock global: o endereco depende so do indice, nao do perfil.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope}))`);
          const [row] = await tx
            .select({
              // Considera TODAS as linhas: bancos antigos alocavam por perfil.
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
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

class DrizzleAuditRepository implements AuditRepository {
  constructor(private readonly db: Database) {}

  async record(input: RecordAuditInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      // A3: sem este lock, duas transacoes concorrentes (API + worker) leem
      // o mesmo antecesor e a cadeia de auditoria BIFURCA silenciosamente.
      // O lock e por transacao (soltado no commit/rollback).
      await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK_ID})`);

      // Ordenacao deterministica: criado_em tem precisao de microsegundo e
      // pode empatar; `id` (uuid random) desempata de forma estavel.
      const [last] = await tx
        .select({ hash: eventosAuditoria.hash })
        .from(eventosAuditoria)
        .orderBy(desc(eventosAuditoria.criadoEm), desc(eventosAuditoria.id))
        .limit(1);
      const hashAnterior = last?.hash ?? null;
      const detalhes = input.detalhes ? JSON.stringify(input.detalhes) : null;
      const hash = createHash('sha256')
        .update(
          [
            hashAnterior ?? '',
            input.ator,
            input.acao,
            input.entidade,
            input.entidadeId ?? '',
            detalhes ?? '',
          ].join('|'),
        )
        .digest('hex');

      await tx.insert(eventosAuditoria).values({
        ator: input.ator,
        acao: input.acao,
        entidade: input.entidade,
        entidadeId: input.entidadeId ?? null,
        detalhes,
        ip: input.ip ?? null,
        hashAnterior,
        hash,
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

export function createRepositories(db: Database): MotorRepositories {
  return {
    customers: new DrizzleCustomerRepository(db),
    rampProfiles: new DrizzleRampProfileRepository(db),
    coldWallets: new DrizzleColdWalletRepository(db),
    links: new DrizzleLinkRepository(db),
    payments: new DrizzlePaymentRepository(db),
    credits: new DrizzleCreditRepository(db),
    transfers: new DrizzleTransferRepository(db),
    cursors: new DrizzleCursorRepository(db),
    anchors: new DrizzleAnchorRepository(db),
    indices: new DrizzleIndexAllocator(db),
    audit: new DrizzleAuditRepository(db),
  };
}
