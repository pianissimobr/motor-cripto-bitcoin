import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { invoices, pixCharges, swapOrders } from '../db/schema.js';

export type ExportKind = 'all' | 'invoices' | 'pix' | 'bitcoin';

export type ExportRow = {
  createdAt: Date;
  tipo: string;
  id: string;
  pedido: string;
  status: string;
  valorCents: bigint;
  moeda: string;
  meio: string;
  pagoEm: Date | null;
  carteira: string | null;
  transacao: string | null;
};

/** Limite por tipo: o arquivo e para o contador, nao para backup. */
export const EXPORT_MAX_ROWS = 10_000;

const HEADER = ['data', 'tipo', 'id', 'pedido', 'status', 'valor', 'moeda', 'meio', 'pago_em', 'carteira', 'transacao'];

/**
 * Uma celula de CSV para planilha brasileira (separador `;`). Texto que
 * comeca com `= + - @` vira texto puro: sem isso, um `order_id` como
 * `=HYPERLINK(...)` viraria formula no Excel (CSV injection).
 */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[;"\n\r]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Centavos -> "1234,56" (virgula decimal, sem milhar: a planilha soma). */
export function centsCell(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n},${(abs % 100n).toString().padStart(2, '0')}`;
}

function dateCell(value: Date | null): string {
  if (!value) return '';
  // Horario de Brasilia, no formato que a planilha reconhece.
  return value.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

export function toCsv(rows: ExportRow[]): string {
  const lines = [HEADER.join(';')];
  for (const row of rows) {
    lines.push(
      [
        dateCell(row.createdAt),
        row.tipo,
        row.id,
        row.pedido,
        row.status,
        centsCell(row.valorCents),
        row.moeda,
        row.meio,
        dateCell(row.pagoEm),
        row.carteira ?? '',
        row.transacao ?? '',
      ]
        .map((cell) => csvCell(cell))
        .join(';'),
    );
  }
  // BOM: o Excel abre UTF-8 com acento certo.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Vendas da loja num periodo, para a contabilidade. So leitura. */
export async function exportRows(
  db: Db,
  clientId: string,
  opts: { kind: ExportKind; from: Date; to: Date },
): Promise<ExportRow[]> {
  const rows: ExportRow[] = [];
  if (opts.kind === 'all' || opts.kind === 'invoices') {
    const list = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.clientId, clientId),
          eq(invoices.mode, 'live'),
          gte(invoices.createdAt, opts.from),
          lte(invoices.createdAt, opts.to),
        ),
      )
      .orderBy(desc(invoices.createdAt))
      .limit(EXPORT_MAX_ROWS);
    for (const r of list) {
      rows.push({
        createdAt: r.createdAt,
        tipo: 'fatura',
        id: r.id,
        pedido: r.orderId,
        status: r.status,
        valorCents: r.amountCents,
        moeda: r.currency,
        meio: r.paidRail ?? '',
        pagoEm: r.paidAt,
        carteira: null,
        transacao: r.txHash,
      });
    }
  }
  if (opts.kind === 'all' || opts.kind === 'pix') {
    const list = await db
      .select()
      .from(pixCharges)
      .where(and(eq(pixCharges.clientId, clientId), gte(pixCharges.createdAt, opts.from), lte(pixCharges.createdAt, opts.to)))
      .orderBy(desc(pixCharges.createdAt))
      .limit(EXPORT_MAX_ROWS);
    for (const r of list) {
      rows.push({
        createdAt: r.createdAt,
        tipo: 'pix',
        id: r.id,
        pedido: r.externalId,
        status: r.status,
        valorCents: r.amountBrlCents,
        moeda: 'BRL',
        meio: 'pix',
        pagoEm: r.paidAt,
        carteira: r.destinationAddress,
        transacao: r.settlementTxHash,
      });
    }
  }
  if (opts.kind === 'all' || opts.kind === 'bitcoin') {
    const list = await db
      .select()
      .from(swapOrders)
      .where(and(eq(swapOrders.clientId, clientId), gte(swapOrders.createdAt, opts.from), lte(swapOrders.createdAt, opts.to)))
      .orderBy(desc(swapOrders.createdAt))
      .limit(EXPORT_MAX_ROWS);
    for (const r of list) {
      rows.push({
        createdAt: r.createdAt,
        tipo: 'bitcoin',
        id: r.id,
        pedido: r.externalId,
        status: r.status,
        valorCents: r.amountFiatCents,
        moeda: r.currency,
        meio: 'bitcoin',
        pagoEm: r.status === 'liquidado' ? r.updatedAt : null,
        carteira: r.destinationAddress,
        transacao: r.deliveryTxHash,
      });
    }
  }
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
