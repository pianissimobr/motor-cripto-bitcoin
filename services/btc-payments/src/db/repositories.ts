import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { assertTransition } from '../domain/status.js';
import type {
  ApiClient,
  HdAddress,
  LightningPayment,
  OnchainPayment,
  OnchainSweep,
  PaidRail,
  PaymentIntent,
  PaymentIntentStatus,
  SweepInput,
  WebhookEvent,
} from '../domain/types.js';
import type { Db } from './client.js';
import {
  apiClients,
  apiNonces,
  auditEvents,
  hdAddresses,
  hdWalletState,
  lightningPayments,
  onchainPayments,
  onchainSweeps,
  paymentIntents,
  webhookEvents,
} from './schema.js';

export type HdWalletStateRecord = {
  nextReceiveIndex: number;
  gapLimit: number;
  xpubFingerprint: string;
};

export type CreateIntentWithAddressInput = {
  clientId: string;
  externalId: string;
  amountSats: bigint;
  description: string | null;
  metadata: Record<string, unknown> | null;
  expiresAt: Date;
  graceUntil: Date;
  maxIndex: number;
  deriveAddress: (index: number) => {
    address: string;
    derivationPath: string;
  };
};

export type CreatedIntentWithAddress = {
  intent: PaymentIntent;
  address: HdAddress;
};

export type SetLightningInvoiceInput = {
  intentId: string;
  paymentHash: string;
  invoice: string;
  lightningExpiresAt: Date;
  amountSats: bigint;
};

export type MarkIntentPaidInput = {
  intentId: string;
  status: 'pago' | 'pago_tardio';
  paidRail: PaidRail;
  paidAmountSats: bigint;
  overpaidSats: bigint;
  paidAt: Date;
  lightningPaymentHash?: string;
  lightningRaw?: Record<string, unknown> | null;
};

export type CreateClientInput = {
  id: string;
  name: string;
  apiKeyPrefix: string;
  apiKeyHash: string;
  requestSecretEnc: string;
  webhookUrl: string;
  webhookSecretEnc: string;
};

export type UpsertOnchainPaymentInput = {
  intentId: string;
  addressId: string;
  txid: string;
  vout: number;
  amountSats: bigint;
  blockHeight: number | null;
  blockHash: string | null;
  confirmations: number;
  status: 'mempool' | 'confirmado';
};

export type SweepCandidate = {
  intentId: string;
  addressId: string;
  address: string;
  addressIndex: number;
  txid: string;
  vout: number;
  amountSats: bigint;
  confirmations: number;
  intentStatus: PaymentIntentStatus;
};

export type ClaimSweepInput = {
  intentId: string;
  addressId: string;
  amountSats: bigint;
  feeSats: bigint;
  coldWalletAddress: string;
  inputs: SweepInput[];
  status?: 'construindo' | 'manual';
  lastError?: string | null;
  createdAt?: Date;
  lastBroadcastAt?: Date | null;
};

export type UpdateSweepInput = {
  id: string;
  status?: OnchainSweep['status'];
  txid?: string | null;
  psbt?: string | null;
  rawTx?: string | null;
  feeSats?: bigint | null;
  inputs?: SweepInput[];
  confirmations?: number;
  lastCheckedAt?: Date | null;
  lastBroadcastAt?: Date | null;
  attempts?: number;
  lastError?: string | null;
  coldWalletAddress?: string | null;
};

export type ClientBalance = {
  clientId: string;
  name: string;
  paidRail: string;
  paidAmountSats: string;
};

export type StatusCounts = {
  intents: Record<string, number>;
  webhooks: Record<string, number>;
  sweeps: Record<string, number>;
  pendingIntents: number;
  dueWebhooks: number;
  activeSweeps: number;
  clientBalances: ClientBalance[];
};

export type InsertWebhookEventInput = {
  clientId: string;
  intentId: string;
  eventType: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
};

export type Repositories = {
  ping: () => Promise<void>;

  // Clientes e nonces
  findClientByApiKeyHash: (hash: string) => Promise<ApiClient | null>;
  findClientById: (id: string) => Promise<ApiClient | null>;
  createClient: (input: CreateClientInput) => Promise<ApiClient>;
  listClients: () => Promise<ApiClient[]>;
  consumeNonce: (clientId: string, nonce: string, expiresAt: Date) => Promise<boolean>;
  cleanupExpiredNonces: () => Promise<number>;

  // HD wallet
  getHdWalletState: () => Promise<HdWalletStateRecord | null>;
  initHdWalletState: (input: {
    gapLimit: number;
    xpubFingerprint: string;
  }) => Promise<void>;
  allocateNextIndex: (maxIndex: number) => Promise<number>;
  insertHdAddress: (input: {
    index: number;
    address: string;
    derivationPath: string;
    intentId?: string | null;
  }) => Promise<HdAddress>;
  findHdAddressById: (id: string) => Promise<HdAddress | null>;
  findHdAddressByIntentId: (intentId: string) => Promise<HdAddress | null>;
  markHdAddressUsed: (id: string) => Promise<void>;

  // Intents
  createIntentWithAddress: (
    input: CreateIntentWithAddressInput,
  ) => Promise<CreatedIntentWithAddress>;
  findIntentByIdForClient: (
    id: string,
    clientId: string,
  ) => Promise<PaymentIntent | null>;
  findIntentByClientAndExternalId: (
    clientId: string,
    externalId: string,
  ) => Promise<PaymentIntent | null>;
  findIntentByLightningPaymentHash: (
    paymentHash: string,
  ) => Promise<PaymentIntent | null>;
  listPendingLightningIntents: (limit: number) => Promise<PaymentIntent[]>;
  listDueIntents: (now: Date, limit: number) => Promise<PaymentIntent[]>;
  listWatchableOnchainIntents: (now: Date, limit: number) => Promise<PaymentIntent[]>;
  setLightningInvoice: (
    input: SetLightningInvoiceInput,
  ) => Promise<PaymentIntent>;
  markCreationFailed: (intentId: string, addressId: string) => Promise<void>;
  markIntentPaid: (input: MarkIntentPaidInput) => Promise<PaymentIntent | null>;
  addOnchainToLightningPaidIntent: (
    intentId: string,
    onchainAmountSats: bigint,
  ) => Promise<PaymentIntent | null>;
  addLightningToOnchainPaidIntent: (input: {
    intentId: string;
    lightningSats: bigint;
    paymentHash: string;
    paidAt: Date;
    raw?: Record<string, unknown> | null;
  }) => Promise<PaymentIntent | null>;
  markIntentExpired: (intentId: string) => Promise<PaymentIntent | null>;
  markIntentPartial: (intentId: string) => Promise<PaymentIntent | null>;
  markIntentCanceled: (intentId: string) => Promise<PaymentIntent | null>;
  markIntentReorg: (intentId: string) => Promise<PaymentIntent | null>;
  revisePaidCustody: (input: {
    intentId: string;
    paidRail: PaidRail;
    paidAmountSats: bigint;
    overpaidSats: bigint;
  }) => Promise<PaymentIntent | null>;
  listRecoveryIntents: (now: Date, limit: number) => Promise<PaymentIntent[]>;
  touchIntent: (id: string) => Promise<void>;

  // On-chain payments
  upsertOnchainPayment: (
    input: UpsertOnchainPaymentInput,
  ) => Promise<OnchainPayment>;
  listOnchainPaymentsForIntent: (intentId: string) => Promise<OnchainPayment[]>;
  updateOnchainPaymentStatus: (input: {
    txid: string;
    vout: number;
    status: OnchainPayment['status'];
    confirmations: number;
    blockHeight: number | null;
    blockHash: string | null;
    /** Permite sair de `gasto` quando o tx de deposito sumiu. */
    forceFromGasto?: boolean;
  }) => Promise<void>;
  sumOnchainForIntent: (
    intentId: string,
    statuses?: Array<'mempool' | 'confirmado'>,
  ) => Promise<bigint>;

  // Sweep
  listConfirmedOnchainPaymentsForSweep: (
    limit: number,
    opts: {
      confirmations: number;
      highValueSats: bigint;
      highValueConfirmations: number;
    },
  ) => Promise<SweepCandidate[]>;
  claimSweep: (input: ClaimSweepInput) => Promise<OnchainSweep | null>;
  findSweepById: (id: string) => Promise<OnchainSweep | null>;
  listSweepsToMonitor: (limit: number) => Promise<OnchainSweep[]>;
  updateSweep: (input: UpdateSweepInput) => Promise<OnchainSweep | null>;
  listSweeps: (limit: number) => Promise<OnchainSweep[]>;
  listSweepsForAddress: (addressId: string) => Promise<OnchainSweep[]>;
  markOnchainPaymentsGasto: (inputs: SweepInput[]) => Promise<void>;
  restoreOnchainPayments: (inputs: SweepInput[]) => Promise<void>;

  // Lightning payments
  findLightningPaymentByHash: (
    paymentHash: string,
  ) => Promise<LightningPayment | null>;
  noteLightningMismatch: (
    paymentHash: string,
    detail: Record<string, unknown>,
  ) => Promise<boolean>;

  // Webhooks
  insertWebhookEvent: (
    input: InsertWebhookEventInput,
  ) => Promise<WebhookEvent | null>;
  listDueWebhookEvents: (now: Date, limit: number) => Promise<WebhookEvent[]>;
  markWebhookDelivered: (id: string) => Promise<void>;
  markWebhookFailed: (input: {
    id: string;
    attempts: number;
    nextAttemptAt: Date;
    lastError: string;
    final: boolean;
  }) => Promise<void>;

  // Observabilidade / admin
  getStatusCounts: () => Promise<StatusCounts>;
  listWebhookEvents: (limit: number) => Promise<WebhookEvent[]>;
  replayWebhookEvent: (id: string) => Promise<WebhookEvent | null>;

  // Auditoria
  insertAuditEvent: (input: {
    actor: string;
    action: string;
    entity: string;
    entityId: string;
    ip?: string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
};

const HOUR_MS = 60 * 60 * 1000;
const ACTIVE_SWEEP_STATUSES = [
  'pendente',
  'construindo',
  'assinando',
  'transmitindo',
  'aguardando_confirmacao_rede',
  'manual',
] as const;

async function transitionIntent(
  database: Db,
  intentId: string,
  to: PaymentIntentStatus,
  from: readonly PaymentIntentStatus[],
  set: Record<string, unknown>,
): Promise<PaymentIntent | null> {
  return database.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, intentId))
      .for('update')
      .limit(1);
    const current = locked[0];
    if (!current || !from.includes(current.status)) return null;
    assertTransition(current.status, to);
    const rows = await tx
      .update(paymentIntents)
      .set(set)
      .where(eq(paymentIntents.id, intentId))
      .returning();
    return rows[0] ?? null;
  });
}

export function createRepositories(db: Db): Repositories {
  return {
    async ping() {
      await db.execute(sql`select 1`);
    },

    async findClientByApiKeyHash(hash) {
      const rows = await db
        .select()
        .from(apiClients)
        .where(eq(apiClients.apiKeyHash, hash))
        .limit(1);
      return rows[0] ?? null;
    },

    async findClientById(id) {
      const rows = await db
        .select()
        .from(apiClients)
        .where(eq(apiClients.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async createClient(input) {
      const rows = await db.insert(apiClients).values(input).returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao criar cliente');
      return row;
    },

    async listClients() {
      return db.select().from(apiClients).orderBy(asc(apiClients.createdAt));
    },

    async consumeNonce(clientId, nonce, expiresAt) {
      const rows = await db
        .insert(apiNonces)
        .values({ clientId, nonce, expiresAt })
        .onConflictDoNothing()
        .returning({ nonce: apiNonces.nonce });
      return rows.length > 0;
    },

    async cleanupExpiredNonces() {
      const rows = await db
        .delete(apiNonces)
        .where(lte(apiNonces.expiresAt, new Date()))
        .returning({ nonce: apiNonces.nonce });
      return rows.length;
    },

    async getHdWalletState() {
      const rows = await db.select().from(hdWalletState).limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        nextReceiveIndex: row.nextReceiveIndex,
        gapLimit: row.gapLimit,
        xpubFingerprint: row.xpubFingerprint,
      };
    },

    async initHdWalletState(input) {
      await db
        .insert(hdWalletState)
        .values({
          id: 1,
          nextReceiveIndex: 0,
          gapLimit: input.gapLimit,
          xpubFingerprint: input.xpubFingerprint,
        })
        .onConflictDoNothing({ target: hdWalletState.id });
    },

    async allocateNextIndex(maxIndex) {
      const result = await db.execute<{ index: number }>(sql`
        UPDATE hd_wallet_state
        SET next_receive_index = next_receive_index + 1,
            updated_at = now()
        WHERE id = 1
          AND next_receive_index < ${maxIndex}
        RETURNING next_receive_index - 1 AS index
      `);
      const row = result[0];
      if (!row) {
        throw new Error(
          'limite de indices HD atingido ou hd_wallet_state nao inicializado',
        );
      }
      const index = Number(row.index);
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`indice HD invalido retornado pelo banco: ${String(row.index)}`);
      }
      return index;
    },

    async insertHdAddress(input) {
      const rows = await db
        .insert(hdAddresses)
        .values({
          index: input.index,
          address: input.address,
          derivationPath: input.derivationPath,
          intentId: input.intentId ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao inserir endereco HD');
      return row;
    },

    async findHdAddressById(id) {
      const rows = await db
        .select()
        .from(hdAddresses)
        .where(eq(hdAddresses.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async findHdAddressByIntentId(intentId) {
      const rows = await db
        .select()
        .from(hdAddresses)
        .where(eq(hdAddresses.intentId, intentId))
        .limit(1);
      return rows[0] ?? null;
    },

    async markHdAddressUsed(id) {
      await db
        .update(hdAddresses)
        .set({ status: 'usada', usedAt: new Date() })
        .where(eq(hdAddresses.id, id));
    },

    async createIntentWithAddress(input) {
      return db.transaction(async (tx) => {
        const result = await tx.execute<{ index: number }>(sql`
          UPDATE hd_wallet_state
          SET next_receive_index = next_receive_index + 1,
              updated_at = now()
          WHERE id = 1
            AND next_receive_index < ${input.maxIndex}
          RETURNING next_receive_index - 1 AS index
        `);
        const indexRow = result[0];
        if (!indexRow) {
          throw new Error(
            'limite de indices HD atingido ou hd_wallet_state nao inicializado',
          );
        }
        const index = Number(indexRow.index);
        const derived = input.deriveAddress(index);

        const addressRows = await tx
          .insert(hdAddresses)
          .values({
            index,
            address: derived.address,
            derivationPath: derived.derivationPath,
            intentId: null,
          })
          .returning();
        const address = addressRows[0];
        if (!address) throw new Error('falha ao inserir endereco HD');

        const intentRows = await tx
          .insert(paymentIntents)
          .values({
            clientId: input.clientId,
            externalId: input.externalId,
            amountSats: input.amountSats,
            description: input.description,
            status: 'criando',
            expiresAt: input.expiresAt,
            graceUntil: input.graceUntil,
            onchainAddressId: address.id,
            metadata: input.metadata,
          })
          .returning();
        const intent = intentRows[0];
        if (!intent) throw new Error('falha ao inserir intent');

        const linkedRows = await tx
          .update(hdAddresses)
          .set({ intentId: intent.id })
          .where(eq(hdAddresses.id, address.id))
          .returning();
        const linkedAddress = linkedRows[0];
        if (!linkedAddress) throw new Error('falha ao vincular endereco a intent');

        return { intent, address: linkedAddress };
      });
    },

    async findIntentByIdForClient(id, clientId) {
      const rows = await db
        .select()
        .from(paymentIntents)
        .where(and(eq(paymentIntents.id, id), eq(paymentIntents.clientId, clientId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async findIntentByClientAndExternalId(clientId, externalId) {
      const rows = await db
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.clientId, clientId),
            eq(paymentIntents.externalId, externalId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async findIntentByLightningPaymentHash(paymentHash) {
      const rows = await db
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.lightningPaymentHash, paymentHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async listPendingLightningIntents(limit) {
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.status, 'pendente'),
            isNotNull(paymentIntents.lightningPaymentHash),
          ),
        )
        .orderBy(asc(paymentIntents.createdAt))
        .limit(limit);
    },

    async listDueIntents(now, limit) {
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.status, 'pendente'),
            lte(paymentIntents.expiresAt, now),
          ),
        )
        .orderBy(asc(paymentIntents.expiresAt))
        .limit(limit);
    },

    async listWatchableOnchainIntents(now, limit) {
      const paidCutoff = new Date(now.getTime() - 24 * HOUR_MS);
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            isNotNull(paymentIntents.onchainAddressId),
            or(
              eq(paymentIntents.status, 'pendente'),
              eq(paymentIntents.status, 'reorg'),
              and(
                inArray(paymentIntents.status, ['pago', 'pago_tardio']),
                gt(paymentIntents.paidAt, paidCutoff),
              ),
              and(
                inArray(paymentIntents.status, ['expirado', 'parcial']),
                gt(paymentIntents.graceUntil, now),
              ),
            ),
          ),
        )
        .orderBy(asc(paymentIntents.createdAt))
        .limit(limit);
    },

    async setLightningInvoice(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(paymentIntents)
          .set({
            lightningPaymentHash: input.paymentHash,
            lightningInvoice: input.invoice,
            lightningExpiresAt: input.lightningExpiresAt,
            status: 'pendente',
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(paymentIntents.id, input.intentId),
              eq(paymentIntents.status, 'criando'),
            ),
          )
          .returning();
        const intent = rows[0];
        if (!intent) throw new Error('intent nao esta no estado criando');

        await tx.insert(lightningPayments).values({
          intentId: intent.id,
          paymentHash: input.paymentHash,
          invoice: input.invoice,
          amountSats: input.amountSats,
          status: 'pendente',
        });
        return intent;
      });
    },

    async markCreationFailed(intentId, addressId) {
      await db.transaction(async (tx) => {
        await tx
          .update(paymentIntents)
          .set({
            status: 'falha_criacao',
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(paymentIntents.id, intentId),
              eq(paymentIntents.status, 'criando'),
            ),
          );
        await tx
          .update(hdAddresses)
          .set({ status: 'abandonada' })
          .where(eq(hdAddresses.id, addressId));
      });
    },

    async markIntentPaid(input) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, input.intentId))
          .for('update')
          .limit(1);
        const current = locked[0];
        const from: PaymentIntentStatus[] = [
          'pendente',
          'expirado',
          'parcial',
          'reorg',
        ];
        if (!current || !from.includes(current.status)) return null;
        assertTransition(current.status, input.status);
        const rows = await tx
          .update(paymentIntents)
          .set({
            status: input.status,
            paidRail: input.paidRail,
            paidAmountSats: input.paidAmountSats,
            overpaidSats: input.overpaidSats,
            paidAt: input.paidAt,
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, input.intentId))
          .returning();
        const updated = rows[0];
        if (!updated) return null;
        if (input.lightningPaymentHash) {
          await tx
            .update(lightningPayments)
            .set({
              status: 'pago',
              amountSats: input.paidAmountSats,
              paidAt: input.paidAt,
              raw: input.lightningRaw ?? null,
              updatedAt: new Date(),
            })
            .where(eq(lightningPayments.paymentHash, input.lightningPaymentHash));
        }
        return updated;
      });
    },

    async addOnchainToLightningPaidIntent(intentId, onchainAmountSats) {
      const rows = await db
        .update(paymentIntents)
        .set({
          paidRail: 'both',
          paidAmountSats: sql`coalesce(${paymentIntents.paidAmountSats}, 0) + ${onchainAmountSats}`,
          overpaidSats: sql`greatest(0, coalesce(${paymentIntents.paidAmountSats}, 0) + ${onchainAmountSats} - ${paymentIntents.amountSats})`,
          version: sql`${paymentIntents.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentIntents.id, intentId),
            inArray(paymentIntents.status, ['pago', 'pago_tardio']),
            eq(paymentIntents.paidRail, 'lightning'),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async addLightningToOnchainPaidIntent(input) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, input.intentId))
          .for('update')
          .limit(1);
        const current = locked[0];
        if (
          !current ||
          (current.status !== 'pago' && current.status !== 'pago_tardio') ||
          current.paidRail !== 'onchain'
        ) {
          return null;
        }
        assertTransition(current.status, current.status);
        const rows = await tx
          .update(paymentIntents)
          .set({
            paidRail: 'both',
            paidAmountSats: sql`coalesce(${paymentIntents.paidAmountSats}, 0) + ${input.lightningSats}`,
            overpaidSats: sql`greatest(0, coalesce(${paymentIntents.paidAmountSats}, 0) + ${input.lightningSats} - ${paymentIntents.amountSats})`,
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, input.intentId))
          .returning();
        const updated = rows[0];
        if (!updated) return null;
        await tx
          .update(lightningPayments)
          .set({
            status: 'pago',
            amountSats: input.lightningSats,
            paidAt: input.paidAt,
            raw: input.raw ?? null,
            updatedAt: new Date(),
          })
          .where(eq(lightningPayments.paymentHash, input.paymentHash));
        return updated;
      });
    },

    async markIntentExpired(intentId) {
      return transitionIntent(db, intentId, 'expirado', ['pendente'], {
        status: 'expirado',
        version: sql`${paymentIntents.version} + 1`,
        updatedAt: new Date(),
      });
    },

    async markIntentPartial(intentId) {
      return transitionIntent(db, intentId, 'parcial', ['pendente'], {
        status: 'parcial',
        version: sql`${paymentIntents.version} + 1`,
        updatedAt: new Date(),
      });
    },

    async markIntentCanceled(intentId) {
      return transitionIntent(db, intentId, 'cancelado', ['pendente'], {
        status: 'cancelado',
        version: sql`${paymentIntents.version} + 1`,
        updatedAt: new Date(),
      });
    },

    async markIntentReorg(intentId) {
      return transitionIntent(db, intentId, 'reorg', ['pago', 'pago_tardio'], {
        status: 'reorg',
        version: sql`${paymentIntents.version} + 1`,
        updatedAt: new Date(),
      });
    },

    async revisePaidCustody(input) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, input.intentId))
          .for('update')
          .limit(1);
        const current = locked[0];
        if (!current || (current.status !== 'pago' && current.status !== 'pago_tardio')) {
          return null;
        }
        assertTransition(current.status, current.status);
        const rows = await tx
          .update(paymentIntents)
          .set({
            paidRail: input.paidRail,
            paidAmountSats: input.paidAmountSats,
            overpaidSats: input.overpaidSats,
            version: sql`${paymentIntents.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, input.intentId))
          .returning();
        return rows[0] ?? null;
      });
    },

    async listRecoveryIntents(now, limit) {
      return db
        .select()
        .from(paymentIntents)
        .where(
          and(
            isNotNull(paymentIntents.onchainAddressId),
            or(
              eq(paymentIntents.status, 'cancelado'),
              and(
                inArray(paymentIntents.status, ['expirado', 'parcial']),
                lte(paymentIntents.graceUntil, now),
              ),
            ),
          ),
        )
        .orderBy(asc(paymentIntents.updatedAt))
        .limit(limit);
    },

    async touchIntent(id) {
      await db
        .update(paymentIntents)
        .set({ updatedAt: new Date() })
        .where(eq(paymentIntents.id, id));
    },

    async upsertOnchainPayment(input) {
      const now = new Date();
      const rows = await db
        .insert(onchainPayments)
        .values({
          intentId: input.intentId,
          addressId: input.addressId,
          txid: input.txid,
          vout: input.vout,
          amountSats: input.amountSats,
          blockHeight: input.blockHeight,
          blockHash: input.blockHash,
          confirmations: input.confirmations,
          status: input.status,
          ...(input.status === 'confirmado' ? { confirmedAt: now } : {}),
        })
        .onConflictDoUpdate({
          target: [onchainPayments.txid, onchainPayments.vout],
          set: {
            blockHeight: input.blockHeight,
            blockHash: input.blockHash,
            confirmations: input.confirmations,
            // Nao reabre um UTXO marcado como gasto por um sweep enquanto o
            // sweep estiver em andamento. Se o sweep falhar, o operador/retry
            // decide o proximo passo.
            status: sql`case when ${onchainPayments.status} = 'gasto' then 'gasto' else excluded.status end`,
            updatedAt: now,
            ...(input.status === 'confirmado' ? { confirmedAt: now } : {}),
          },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('falha ao gravar pagamento on-chain');
      return row;
    },

    async listOnchainPaymentsForIntent(intentId) {
      return db
        .select()
        .from(onchainPayments)
        .where(eq(onchainPayments.intentId, intentId));
    },

    async updateOnchainPaymentStatus(input) {
      const filters = [
        eq(onchainPayments.txid, input.txid),
        eq(onchainPayments.vout, input.vout),
      ];
      if (!input.forceFromGasto && input.status !== 'gasto') {
        filters.push(ne(onchainPayments.status, 'gasto'));
      }
      await db
        .update(onchainPayments)
        .set({
          status: input.status,
          confirmations: input.confirmations,
          blockHeight: input.blockHeight,
          blockHash: input.blockHash,
          updatedAt: new Date(),
        })
        .where(and(...filters));
    },

    async sumOnchainForIntent(intentId, statuses = ['mempool', 'confirmado']) {
      const rows = await db
        .select({ amountSats: onchainPayments.amountSats })
        .from(onchainPayments)
        .where(
          and(
            eq(onchainPayments.intentId, intentId),
            inArray(onchainPayments.status, statuses),
          ),
        );
      return rows.reduce((total, row) => total + row.amountSats, 0n);
    },

    async listConfirmedOnchainPaymentsForSweep(limit, opts) {
      const rows = await db.execute<{
        intent_id: string;
        address_id: string;
        address: string;
        address_index: number;
        txid: string;
        vout: number;
        amount_sats: string;
        confirmations: number;
        intent_status: PaymentIntentStatus;
      }>(sql`
        select op.intent_id, op.address_id, ha.address,
               ha."index" as address_index, op.txid, op.vout,
               op.amount_sats, op.confirmations,
               pi.status as intent_status
        from onchain_payments op
        join hd_addresses ha on ha.id = op.address_id
        join payment_intents pi on pi.id = op.intent_id
        where op.status = 'confirmado'
          and pi.status in ('pago','pago_tardio','parcial','expirado','cancelado')
          and op.confirmations >= case
            when pi.amount_sats >= ${opts.highValueSats.toString()}::bigint
              then ${opts.highValueConfirmations}::int
            else ${opts.confirmations}::int
          end
          and not exists (
            select 1 from onchain_sweeps s
            where s.address_id = op.address_id
              and s.status in ('pendente','construindo','assinando','transmitindo','aguardando_confirmacao_rede','manual')
          )
        order by op.address_id, op.first_seen_at
        limit ${limit}
      `);
      return rows.map((row) => ({
        intentId: row.intent_id,
        addressId: row.address_id,
        address: row.address,
        addressIndex: Number(row.address_index),
        txid: row.txid,
        vout: Number(row.vout),
        amountSats: BigInt(String(row.amount_sats)),
        confirmations: Number(row.confirmations),
        intentStatus: row.intent_status,
      }));
    },

    async claimSweep(input) {
      return db.transaction(async (tx) => {
        const locked = await tx.execute<{ id: string }>(sql`
          select id from hd_addresses where id = ${input.addressId} for update
        `);
        if (locked.length === 0) return null;

        const active = await tx
          .select()
          .from(onchainSweeps)
          .where(
            and(
              eq(onchainSweeps.addressId, input.addressId),
              inArray(onchainSweeps.status, [...ACTIVE_SWEEP_STATUSES]),
            ),
          )
          .limit(1);
        if (active.length > 0) return null;

        const rows = await tx
          .insert(onchainSweeps)
          .values({
            intentId: input.intentId,
            addressId: input.addressId,
            amountSats: input.amountSats,
            feeSats: input.feeSats,
            coldWalletAddress: input.coldWalletAddress,
            inputs: input.inputs,
            status: input.status ?? 'construindo',
            lastError: input.lastError ?? null,
            ...(input.createdAt ? { createdAt: input.createdAt } : {}),
            ...(input.lastBroadcastAt !== undefined
              ? { lastBroadcastAt: input.lastBroadcastAt }
              : {}),
          })
          .returning();
        return rows[0] ?? null;
      });
    },

    async findSweepById(id) {
      const rows = await db
        .select()
        .from(onchainSweeps)
        .where(eq(onchainSweeps.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async listSweepsToMonitor(limit) {
      return db
        .select()
        .from(onchainSweeps)
        .where(
          inArray(onchainSweeps.status, [
            'transmitindo',
            'aguardando_confirmacao_rede',
          ]),
        )
        .orderBy(asc(onchainSweeps.updatedAt))
        .limit(limit);
    },

    async updateSweep(input) {
      const rows = await db
        .update(onchainSweeps)
        .set({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.txid !== undefined ? { txid: input.txid } : {}),
          ...(input.psbt !== undefined ? { psbt: input.psbt } : {}),
          ...(input.rawTx !== undefined ? { rawTx: input.rawTx } : {}),
          ...(input.feeSats !== undefined ? { feeSats: input.feeSats } : {}),
          ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
          ...(input.confirmations !== undefined
            ? { confirmations: input.confirmations }
            : {}),
          ...(input.lastCheckedAt !== undefined
            ? { lastCheckedAt: input.lastCheckedAt }
            : {}),
          ...(input.lastBroadcastAt !== undefined
            ? { lastBroadcastAt: input.lastBroadcastAt }
            : {}),
          ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
          ...(input.lastError !== undefined
            ? { lastError: input.lastError }
            : {}),
          ...(input.coldWalletAddress !== undefined
            ? { coldWalletAddress: input.coldWalletAddress }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(onchainSweeps.id, input.id))
        .returning();
      return rows[0] ?? null;
    },

    async listSweeps(limit) {
      return db
        .select()
        .from(onchainSweeps)
        .orderBy(asc(onchainSweeps.createdAt))
        .limit(limit);
    },

    async listSweepsForAddress(addressId) {
      return db
        .select()
        .from(onchainSweeps)
        .where(eq(onchainSweeps.addressId, addressId));
    },

    async markOnchainPaymentsGasto(inputs) {
      for (const input of inputs) {
        await db
          .update(onchainPayments)
          .set({ status: 'gasto', updatedAt: new Date() })
          .where(
            and(
              eq(onchainPayments.txid, input.txid),
              eq(onchainPayments.vout, input.vout),
            ),
          );
      }
    },

    async restoreOnchainPayments(inputs) {
      for (const input of inputs) {
        await db
          .update(onchainPayments)
          .set({ status: 'confirmado', updatedAt: new Date() })
          .where(
            and(
              eq(onchainPayments.txid, input.txid),
              eq(onchainPayments.vout, input.vout),
              eq(onchainPayments.status, 'gasto'),
            ),
          );
      }
    },

    async findLightningPaymentByHash(paymentHash) {
      const rows = await db
        .select()
        .from(lightningPayments)
        .where(eq(lightningPayments.paymentHash, paymentHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async noteLightningMismatch(paymentHash, detail) {
      const rows = await db
        .update(lightningPayments)
        .set({
          raw: { kind: 'amount_mismatch', ...detail },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(lightningPayments.paymentHash, paymentHash),
            sql`coalesce(${lightningPayments.raw}->>'kind', '') = ''`,
          ),
        )
        .returning({ id: lightningPayments.id });
      return rows.length > 0;
    },

    async insertWebhookEvent(input) {
      const rows = await db
        .insert(webhookEvents)
        .values({
          clientId: input.clientId,
          intentId: input.intentId,
          eventType: input.eventType,
          dedupeKey: input.dedupeKey,
          payload: input.payload,
        })
        .onConflictDoNothing({ target: webhookEvents.dedupeKey })
        .returning();
      return rows[0] ?? null;
    },

    async listDueWebhookEvents(now, limit) {
      return db
        .select()
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.status, 'pendente'),
            lte(webhookEvents.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(webhookEvents.nextAttemptAt))
        .limit(limit);
    },

    async markWebhookDelivered(id) {
      await db
        .update(webhookEvents)
        .set({
          status: 'entregue',
          deliveredAt: new Date(),
          attempts: sql`${webhookEvents.attempts} + 1`,
        })
        .where(eq(webhookEvents.id, id));
    },

    async markWebhookFailed(input) {
      await db
        .update(webhookEvents)
        .set({
          attempts: input.attempts,
          nextAttemptAt: input.nextAttemptAt,
          lastError: input.lastError,
          status: input.final ? 'falhou' : 'pendente',
        })
        .where(eq(webhookEvents.id, input.id));
    },

    async listWebhookEvents(limit) {
      return db
        .select()
        .from(webhookEvents)
        .orderBy(asc(webhookEvents.createdAt))
        .limit(limit);
    },

    async replayWebhookEvent(id) {
      const rows = await db
        .update(webhookEvents)
        .set({
          status: 'pendente',
          nextAttemptAt: new Date(),
          attempts: 0,
          lastError: null,
          deliveredAt: null,
        })
        .where(eq(webhookEvents.id, id))
        .returning();
      return rows[0] ?? null;
    },

    async getStatusCounts() {
      const [intents, webhooks, sweeps, pending, due, active] = await Promise.all([
        db.execute<{ status: string; count: number }>(sql`
          select status, count(*)::int as count
          from payment_intents
          group by status
        `),
        db.execute<{ status: string; count: number }>(sql`
          select status, count(*)::int as count
          from webhook_events
          group by status
        `),
        db.execute<{ status: string; count: number }>(sql`
          select status, count(*)::int as count
          from onchain_sweeps
          group by status
        `),
        db.execute<{ count: number }>(sql`
          select count(*)::int as count
          from payment_intents
          where status = 'pendente'
        `),
        db.execute<{ count: number }>(sql`
          select count(*)::int as count
          from webhook_events
          where status = 'pendente' and next_attempt_at <= now()
        `),
        db.execute<{ count: number }>(sql`
          select count(*)::int as count
          from onchain_sweeps
          where status in ('pendente','construindo','assinando','transmitindo','aguardando_confirmacao_rede','manual')
        `),
      ]);
      const toRecord = (rows: Array<{ status: string; count: number }>) =>
        Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
      const balances = await db.execute<{
        client_id: string;
        name: string;
        paid_rail: string;
        paid_amount_sats: string;
      }>(sql`
        select c.id as client_id, c.name, pi.paid_rail,
               coalesce(sum(pi.paid_amount_sats), 0)::text as paid_amount_sats
        from api_clients c
        join payment_intents pi on pi.client_id = c.id
        where pi.status in ('pago', 'pago_tardio')
          and pi.paid_rail is not null
        group by c.id, c.name, pi.paid_rail
        order by c.name, pi.paid_rail
      `);
      return {
        intents: toRecord(intents),
        webhooks: toRecord(webhooks),
        sweeps: toRecord(sweeps),
        pendingIntents: Number(pending[0]?.count ?? 0),
        dueWebhooks: Number(due[0]?.count ?? 0),
        activeSweeps: Number(active[0]?.count ?? 0),
        clientBalances: balances.map((row) => ({
          clientId: row.client_id,
          name: row.name,
          paidRail: row.paid_rail,
          paidAmountSats: String(row.paid_amount_sats),
        })),
      };
    },

    async insertAuditEvent(input) {
      await db.insert(auditEvents).values({
        actor: input.actor,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        ip: input.ip ?? null,
        metadata: input.metadata ?? null,
      });
    },
  };
}
