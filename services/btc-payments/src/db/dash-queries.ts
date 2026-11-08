import { and, asc, desc, eq, gte, ilike, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from './client.js';
import { merchantWallets, paymentRequests, pixCharges, swapOrders, webhookEvents } from './schema.js';

/**
 * Consultas do painel do lojista. Toda funcao recebe o `clientId` da loja e
 * filtra por ele: a posse (usuario -> loja) e conferida antes, na rota.
 */

export type PageCursor = { createdAt: Date; id: string };

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

export function decodeCursor(value: string | undefined): PageCursor | null {
  if (!value) return null;
  const [iso, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

export type PaymentFilter = {
  clientId: string;
  status?: string[];
  externalId?: string;
  from?: Date;
  to?: Date;
  cursor?: PageCursor | null;
  limit: number;
};

/** Keyset decrescente por (created_at, id): estavel mesmo com linhas novas. */
function keyset(
  table: typeof pixCharges | typeof swapOrders | typeof paymentRequests,
  cursor: PageCursor | null | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(table.createdAt, cursor.createdAt),
    and(eq(table.createdAt, cursor.createdAt), lt(table.id, cursor.id)),
  );
}

function common(
  table: typeof pixCharges | typeof swapOrders | typeof paymentRequests,
  filter: PaymentFilter,
): SQL[] {
  const where: (SQL | undefined)[] = [
    eq(table.clientId, filter.clientId),
    filter.status?.length ? sql`${table.status} in (${sql.join(filter.status.map((s) => sql`${s}`), sql`, `)})` : undefined,
    filter.externalId ? ilike(table.externalId, `%${filter.externalId.replace(/[%_\\]/g, '\\$&')}%`) : undefined,
    filter.from ? gte(table.createdAt, filter.from) : undefined,
    filter.to ? lte(table.createdAt, filter.to) : undefined,
    keyset(table, filter.cursor),
  ];
  return where.filter((w): w is SQL => w !== undefined);
}

export function createDashQueries(db: Db) {
  return {
    async listPixCharges(filter: PaymentFilter) {
      return db
        .select()
        .from(pixCharges)
        .where(and(...common(pixCharges, filter)))
        .orderBy(desc(pixCharges.createdAt), desc(pixCharges.id))
        .limit(filter.limit + 1);
    },

    async listSwapOrders(filter: PaymentFilter) {
      return db
        .select()
        .from(swapOrders)
        .where(and(...common(swapOrders, filter)))
        .orderBy(desc(swapOrders.createdAt), desc(swapOrders.id))
        .limit(filter.limit + 1);
    },

    /**
     * Pedidos com o estado de cada trilho junto (o status do pedido e
     * derivado deles). O filtro de status e aplicado depois, no servico.
     */
    async listPaymentRequests(filter: Omit<PaymentFilter, 'status'>) {
      return db
        .select({
          request: paymentRequests,
          pixStatus: pixCharges.status,
          swapStatus: swapOrders.status,
        })
        .from(paymentRequests)
        .leftJoin(pixCharges, eq(pixCharges.id, paymentRequests.pixChargeId))
        .leftJoin(swapOrders, eq(swapOrders.id, paymentRequests.swapOrderId))
        .where(and(...common(paymentRequests, filter)))
        .orderBy(desc(paymentRequests.createdAt), desc(paymentRequests.id))
        .limit(filter.limit + 1);
    },

    /** Entregas de webhook da loja (todas, ou so as de uma cobranca Pix). */
    async listWebhookEvents(clientId: string, opts: { pixChargeId?: string; limit: number }) {
      return db
        .select()
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.clientId, clientId),
            opts.pixChargeId ? eq(webhookEvents.pixChargeId, opts.pixChargeId) : undefined,
          ),
        )
        .orderBy(desc(webhookEvents.createdAt))
        .limit(opts.limit);
    },

    async findWebhookEvent(clientId: string, id: string) {
      const rows = await db
        .select()
        .from(webhookEvents)
        .where(and(eq(webhookEvents.id, id), eq(webhookEvents.clientId, clientId)))
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Numeros da visao geral desde `since`: cobrancas criadas e pagas e o
     * valor recebido em centavos de real, por trilho, e a serie por dia.
     */
    async overview(clientId: string, since: Date) {
      const pix = await db.execute<{ total: string; paid: string; paid_cents: string | null }>(sql`
        select count(*)::text as total,
               count(*) filter (where status in ('pago', 'liquidado'))::text as paid,
               sum(amount_brl_cents) filter (where status in ('pago', 'liquidado'))::text as paid_cents
          from pix_charges
         where client_id = ${clientId} and created_at >= ${since.toISOString()}::timestamptz`);
      const swap = await db.execute<{ total: string; paid: string; paid_cents: string | null }>(sql`
        select count(*)::text as total,
               count(*) filter (where status = 'liquidado')::text as paid,
               sum(amount_fiat_cents) filter (where status = 'liquidado' and currency = 'BRL')::text as paid_cents
          from swap_orders
         where client_id = ${clientId} and created_at >= ${since.toISOString()}::timestamptz`);
      const series = await db.execute<{ day: string; rail: string; paid_cents: string; count: string }>(sql`
        select to_char(date_trunc('day', coalesce(paid_at, created_at)), 'YYYY-MM-DD') as day,
               'pix' as rail,
               sum(amount_brl_cents)::text as paid_cents,
               count(*)::text as count
          from pix_charges
         where client_id = ${clientId} and created_at >= ${since.toISOString()}::timestamptz and status in ('pago', 'liquidado')
         group by 1
        union all
        select to_char(date_trunc('day', updated_at), 'YYYY-MM-DD') as day,
               'bitcoin' as rail,
               sum(amount_fiat_cents)::text as paid_cents,
               count(*)::text as count
          from swap_orders
         where client_id = ${clientId} and created_at >= ${since.toISOString()}::timestamptz and status = 'liquidado' and currency = 'BRL'
         group by 1
         order by 1`);
      return { pix: pix[0], swap: swap[0], series: [...series] };
    },

    async listSettlementWallets(clientId: string) {
      return db
        .select()
        .from(merchantWallets)
        .where(
          and(
            eq(merchantWallets.merchantId, clientId),
            eq(merchantWallets.kind, 'usdc_settlement'),
            eq(merchantWallets.purpose, 'loja'),
            eq(merchantWallets.status, 'ativo'),
          ),
        )
        .orderBy(desc(merchantWallets.isDefault), asc(merchantWallets.createdAt));
    },

    async findSettlementWallet(clientId: string, id: string) {
      const rows = await db
        .select()
        .from(merchantWallets)
        .where(
          and(
            eq(merchantWallets.id, id),
            eq(merchantWallets.merchantId, clientId),
            eq(merchantWallets.kind, 'usdc_settlement'),
            eq(merchantWallets.purpose, 'loja'),
            eq(merchantWallets.status, 'ativo'),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Cadastra a carteira. A primeira da loja na rede ja nasce padrao. Um
     * endereco que a loja tinha removido volta a ficar ativo.
     */
    async addSettlementWallet(input: { clientId: string; chain: string; network: string; address: string; label: string | null }) {
      return db.transaction(async (tx) => {
        const others = await tx
          .select({ id: merchantWallets.id })
          .from(merchantWallets)
          .where(
            and(
              eq(merchantWallets.merchantId, input.clientId),
              eq(merchantWallets.kind, 'usdc_settlement'),
              eq(merchantWallets.purpose, 'loja'),
              eq(merchantWallets.chain, input.chain),
              eq(merchantWallets.status, 'ativo'),
            ),
          );
        const isDefault = others.length === 0;
        const existing = await tx
          .select()
          .from(merchantWallets)
          .where(and(eq(merchantWallets.chain, input.chain), eq(merchantWallets.address, input.address)))
          .limit(1);
        const found = existing[0];
        if (found) {
          if (found.merchantId !== input.clientId || found.status === 'ativo' || found.kind !== 'usdc_settlement' || found.purpose !== 'loja') {
            return { conflict: true as const };
          }
          const revived = await tx
            .update(merchantWallets)
            .set({ status: 'ativo', label: input.label, isDefault, updatedAt: new Date() })
            .where(eq(merchantWallets.id, found.id))
            .returning();
          return { conflict: false as const, wallet: revived[0]! };
        }
        const inserted = await tx
          .insert(merchantWallets)
          .values({
            merchantId: input.clientId,
            kind: 'usdc_settlement',
            purpose: 'loja',
            chain: input.chain,
            network: input.network,
            address: input.address,
            label: input.label,
            isDefault,
            status: 'ativo',
          })
          .returning();
        return { conflict: false as const, wallet: inserted[0]! };
      });
    },

    async setDefaultSettlementWallet(clientId: string, id: string, chain: string) {
      await db.transaction(async (tx) => {
        await tx
          .update(merchantWallets)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(merchantWallets.merchantId, clientId),
              eq(merchantWallets.kind, 'usdc_settlement'),
              eq(merchantWallets.chain, chain),
              ne(merchantWallets.id, id),
            ),
          );
        await tx
          .update(merchantWallets)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(and(eq(merchantWallets.id, id), eq(merchantWallets.merchantId, clientId)));
      });
    },

    async renameSettlementWallet(clientId: string, id: string, label: string | null) {
      await db
        .update(merchantWallets)
        .set({ label, updatedAt: new Date() })
        .where(and(eq(merchantWallets.id, id), eq(merchantWallets.merchantId, clientId)));
    },

    /** Remove (inativa). Se era a padrao, a mais antiga que sobrou assume. */
    async removeSettlementWallet(clientId: string, id: string, chain: string) {
      await db.transaction(async (tx) => {
        await tx
          .update(merchantWallets)
          .set({ status: 'inativo', isDefault: false, updatedAt: new Date() })
          .where(and(eq(merchantWallets.id, id), eq(merchantWallets.merchantId, clientId)));
        const rest = await tx
          .select()
          .from(merchantWallets)
          .where(
            and(
              eq(merchantWallets.merchantId, clientId),
              eq(merchantWallets.kind, 'usdc_settlement'),
              eq(merchantWallets.purpose, 'loja'),
              eq(merchantWallets.chain, chain),
              eq(merchantWallets.status, 'ativo'),
            ),
          )
          .orderBy(desc(merchantWallets.isDefault), asc(merchantWallets.createdAt));
        const first = rest[0];
        if (first && !first.isDefault) {
          await tx.update(merchantWallets).set({ isDefault: true, updatedAt: new Date() }).where(eq(merchantWallets.id, first.id));
        }
      });
    },
  };
}

export type DashQueries = ReturnType<typeof createDashQueries>;
