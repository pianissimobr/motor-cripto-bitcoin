import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
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

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

function toStoredCustomer(row: typeof cadastros.$inferSelect): StoredCustomer {
  return {
    id: row.id,
    nomeEnc: dec(row.nomeEnc),
    emailEnc: dec(row.emailEnc),
    emailBidx: row.emailBidx,
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
          nomeMasked: input.nomeMasked,
          emailMasked: input.emailMasked,
          status: input.status ?? 'ativo',
        })
        .returning();
      if (!row) throw new Error('falha ao inserir cadastro');

      if (input.prefixBidxList.length > 0) {
        await tx
          .insert(cadastrosPrefixos)
          .values(
            input.prefixBidxList.map((prefixBidx) => ({
              prefixBidx,
              clienteId: input.id,
            })),
          )
          .onConflictDoNothing();
      }
      return toStoredCustomer(row);
    });
  }

  async findById(id: string): Promise<StoredCustomer | null> {
    const [row] = await this.db.select().from(cadastros).where(eq(cadastros.id, id)).limit(1);
    return row ? toStoredCustomer(row) : null;
  }

  async findByEmailBidx(emailBidx: string): Promise<StoredCustomer | null> {
    const [row] = await this.db
      .select()
      .from(cadastros)
      .where(eq(cadastros.emailBidx, emailBidx))
      .limit(1);
    return row ? toStoredCustomer(row) : null;
  }

  async searchByEmailPrefixBidx(prefixBidx: string, limit: number): Promise<StoredCustomer[]> {
    const rows = await this.db
      .select({ c: cadastros })
      .from(cadastrosPrefixos)
      .innerJoin(cadastros, eq(cadastrosPrefixos.clienteId, cadastros.id))
      .where(eq(cadastrosPrefixos.prefixBidx, prefixBidx))
      .orderBy(asc(cadastros.criadoEm))
      .limit(limit);
    return rows.map((r) => toStoredCustomer(r.c));
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
    return row?.n ?? 0;
  }
}

/* ------------------------------------------------------------------ */
/* Ramp profiles                                                       */
/* ------------------------------------------------------------------ */

function toRampProfile(row: typeof rampProfiles.$inferSelect): RampProfile {
  return {
    id: row.id,
    label: row.label,
    chain: row.chain,
    asset: row.asset,
    tokenContract: row.tokenContract,
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
        chain: input.chain,
        asset: input.asset,
        tokenContract: input.tokenContract,
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
    address: row.address,
    chain: row.chain,
    criadoEm: row.criadoEm,
  };
}

class DrizzleColdWalletRepository implements ColdWalletRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateColdWalletInput): Promise<ColdWallet> {
    const [row] = await this.db
      .insert(carteirasFrias)
      .values({ label: input.label, address: input.address, chain: input.chain })
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
      .where(eq(carteirasFrias.address, address.toLowerCase()))
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
    tokenContract: row.tokenContract,
    decimals: row.decimals,
    moedaFiat: row.moedaFiat,
    valorFiatCentavos: row.valorFiatCentavos,
    valorFiatUnidades: row.valorFiatUnidades,
    taxaTokenPorFiatBaseUnits: row.taxaTokenPorFiatBaseUnits,
    expectedBaseUnits: row.expectedBaseUnits,
    indiceHd: row.indiceHd,
    caminhoDerivacao: row.caminhoDerivacao,
    enderecoDeposito: row.enderecoDeposito,
    carteiraFriaId: row.carteiraFriaId,
    carteiraFriaEndereco: row.carteiraFriaEndereco,
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
            eq(hdIndices.scope, input.rampProfileId),
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
      .where(eq(linksGerados.enderecoDeposito, address.toLowerCase()))
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
    txHash: row.txHash,
    logIndex: row.logIndex,
    deAddress: row.deAddress,
    paraAddress: row.paraAddress,
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
    const existing = await this.db
      .select()
      .from(linksPagos)
      .where(and(eq(linksPagos.txHash, input.txHash), eq(linksPagos.logIndex, input.logIndex)))
      .limit(1);

    if (existing.length > 0) {
      const row = existing[0]!;
      // Mantem o status mais avancado (detectado < confirmado).
      const nextStatus =
        row.status === 'confirmado' ? 'confirmado' : input.status;
      if (nextStatus !== row.status) {
        const [updated] = await this.db
          .update(linksPagos)
          .set({
            status: nextStatus,
            ...(nextStatus === 'confirmado' ? { confirmadoEm: new Date() } : {}),
          })
          .where(eq(linksPagos.id, row.id))
          .returning();
        return toPayment(updated ?? row);
      }
      return toPayment(row);
    }

    const [row] = await this.db
      .insert(linksPagos)
      .values({
        linkId: input.linkId,
        txHash: input.txHash,
        logIndex: input.logIndex,
        deAddress: input.deAddress,
        paraAddress: input.paraAddress,
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
        .where(
          and(eq(linksPagos.txHash, input.txHash), eq(linksPagos.logIndex, input.logIndex)),
        )
        .limit(1);
      if (again) return toPayment(again);
      throw new Error('falha ao registrar pagamento');
    }
    return toPayment(row);
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

  async sumConfirmedByLink(linkId: string): Promise<bigint> {
    const [row] = await this.db
      .select({ total: sql<bigint>`coalesce(sum(${linksPagos.valorBaseUnits}), 0)` })
      .from(linksPagos)
      .where(and(eq(linksPagos.linkId, linkId), eq(linksPagos.status, 'confirmado')));
    return row?.total ?? 0n;
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
      .select({ total: sql<number | null>`sum(${creditosCliente.valorCentavos})` })
      .from(creditosCliente)
      .where(
        and(eq(creditosCliente.clienteId, clienteId), eq(creditosCliente.status, 'liberado')),
      );
    return row?.total ?? 0;
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
}

/* ------------------------------------------------------------------ */
/* Internal transfers (sweeps)                                         */
/* ------------------------------------------------------------------ */

function toTransfer(row: typeof movimentosInternos.$inferSelect): InternalTransfer {
  return {
    id: row.id,
    linkId: row.linkId,
    deAddress: row.deAddress,
    paraAddress: row.paraAddress,
    valorBaseUnits: row.valorBaseUnits,
    txHash: row.txHash,
    status: row.status as TransferStatus,
    erro: row.erro,
    chain: row.chain,
    bloco: row.bloco,
    nonce: row.nonce,
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
        deAddress: input.deAddress,
        paraAddress: input.paraAddress,
        valorBaseUnits: input.valorBaseUnits,
        txHash: input.txHash ?? null,
        status: input.status,
        erro: input.erro ?? null,
        chain: input.chain,
        bloco: input.bloco ?? null,
        nonce: input.nonce ?? null,
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
        'status' | 'txHash' | 'erro' | 'valorBaseUnits' | 'paraAddress' | 'bloco'
      >
    >,
  ): Promise<void> {
    await this.db
      .update(movimentosInternos)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.txHash !== undefined ? { txHash: patch.txHash } : {}),
        ...(patch.erro !== undefined ? { erro: patch.erro } : {}),
        ...(patch.valorBaseUnits !== undefined
          ? { valorBaseUnits: patch.valorBaseUnits }
          : {}),
        ...(patch.paraAddress !== undefined ? { paraAddress: patch.paraAddress } : {}),
        ...(patch.bloco !== undefined ? { bloco: patch.bloco } : {}),
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

  /** C5: um sweep cujo bloco caiu no reorg precisa ser refeito. */
  async revertAboveBlock(chain: string, bloco: number): Promise<number> {
    const rows = await this.db
      .update(movimentosInternos)
      .set({ status: 'pendente', txHash: null, bloco: null, erro: 'reorg: refazer sweep' })
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

  async allocate(scope: string): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope}))`);
          const [row] = await tx
            .insert(hdIndices)
            .values({
              scope,
              indice: sql`(select coalesce(max(indice) + 1, 0) from ${hdIndices} where scope = ${scope})`,
            })
            .returning();
          if (!row) throw new Error('falha ao alocar indice HD');
          return row.indice;
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
