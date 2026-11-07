import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

export type ReportServiceDeps = {
  db: Db;
};

export type ReportSummary = {
  intentsTotal: number;
  intentsPaid: number;
  intentsExpired: number;
  intentsCanceled: number;
  satsCharged: string;
  satsPaid: string;
  byRail: { lightning: string; onchain: string; both: string };
  pixChargesTotal: number;
  pixPaid: number;
  pixBrlCents: string;
  pixUsdcMinor: string;
  /** USDC das conversoes BTC entregue direto na carteira da loja. */
  btcUsdcMinor: string;
  /** Total de USDC entregue a loja (BTC convertido + PIX liquidado). */
  payoutUsdcMinor: string;
};

export type RailSlice = {
  rail: string;
  count: number;
  sats: string;
};

export type SeriesPoint = {
  day: string;
  total: number;
  paid: number;
  sats: string;
};

type IntentAgg = {
  intents_total: number;
  intents_paid: number;
  intents_expired: number;
  intents_canceled: number;
  sats_charged: string;
  sats_paid: string;
  rail_lightning: string;
  rail_onchain: string;
  rail_both: string;
};

type PixAgg = {
  total: number;
  paid: number;
  brl_cents: string;
  usdc_minor: string;
};

type ConversionAgg = { usdc_minor: string };

export class ReportService {
  private readonly db: Db;

  constructor(deps: ReportServiceDeps) {
    this.db = deps.db;
  }

  async summary(clientId: string, since: Date): Promise<ReportSummary> {
    const [intentRows, pixRows, conversionRows] = await Promise.all([
      this.db.execute<IntentAgg>(sql`
        select
          count(*)::int as intents_total,
          count(*) filter (where status in ('pago','pago_tardio'))::int as intents_paid,
          count(*) filter (where status = 'expirado')::int as intents_expired,
          count(*) filter (where status = 'cancelado')::int as intents_canceled,
          coalesce(sum(amount_sats), 0)::text as sats_charged,
          coalesce(sum(paid_amount_sats) filter (where status in ('pago','pago_tardio')), 0)::text as sats_paid,
          coalesce(sum(paid_amount_sats) filter (where paid_rail = 'lightning'), 0)::text as rail_lightning,
          coalesce(sum(paid_amount_sats) filter (where paid_rail = 'onchain'), 0)::text as rail_onchain,
          coalesce(sum(paid_amount_sats) filter (where paid_rail = 'both'), 0)::text as rail_both
        from payment_intents
        where client_id = ${clientId} and created_at >= ${since.toISOString()}::timestamptz
      `),
      this.db.execute<PixAgg>(sql`
        select
          count(*)::int as total,
          count(*) filter (where status in ('pago','liquidado'))::int as paid,
          coalesce(sum(amount_brl_cents), 0)::text as brl_cents,
          coalesce(sum(asset_amount_minor) filter (where status = 'liquidado'), 0)::text as usdc_minor
        from pix_charges
        where client_id = ${clientId} and created_at >= ${since.toISOString()}::timestamptz
      `),
      this.db.execute<ConversionAgg>(sql`
        select coalesce(sum(target_amount_minor) filter (where status = 'convertida'), 0)::text as usdc_minor
        from conversion_orders
        where merchant_id = ${clientId} and created_at >= ${since.toISOString()}::timestamptz
      `),
    ]);

    const intent = intentRows[0] ?? {
      intents_total: 0,
      intents_paid: 0,
      intents_expired: 0,
      intents_canceled: 0,
      sats_charged: '0',
      sats_paid: '0',
      rail_lightning: '0',
      rail_onchain: '0',
      rail_both: '0',
    };
    const pix = pixRows[0] ?? { total: 0, paid: 0, brl_cents: '0', usdc_minor: '0' };
    const conversion = conversionRows[0] ?? { usdc_minor: '0' };

    return {
      intentsTotal: intent.intents_total,
      intentsPaid: intent.intents_paid,
      intentsExpired: intent.intents_expired,
      intentsCanceled: intent.intents_canceled,
      satsCharged: intent.sats_charged,
      satsPaid: intent.sats_paid,
      byRail: {
        lightning: intent.rail_lightning,
        onchain: intent.rail_onchain,
        both: intent.rail_both,
      },
      pixChargesTotal: pix.total,
      pixPaid: pix.paid,
      pixBrlCents: pix.brl_cents,
      pixUsdcMinor: pix.usdc_minor,
      btcUsdcMinor: conversion.usdc_minor,
      payoutUsdcMinor: (BigInt(conversion.usdc_minor) + BigInt(pix.usdc_minor)).toString(),
    };
  }

  async byRail(clientId: string, since: Date): Promise<RailSlice[]> {
    const rows = await this.db.execute<{
      rail: string;
      count: number;
      sats: string;
    }>(sql`
      select
        coalesce(paid_rail, 'nao_pago') as rail,
        count(*)::int as count,
        coalesce(sum(coalesce(paid_amount_sats, 0)), 0)::text as sats
      from payment_intents
      where client_id = ${clientId} and created_at >= ${since.toISOString()}::timestamptz
      group by 1
      order by 1
    `);
    return rows.map((row) => ({ rail: row.rail, count: row.count, sats: row.sats }));
  }

  async series(clientId: string, since: Date): Promise<SeriesPoint[]> {
    const rows = await this.db.execute<{
      day: string;
      total: number;
      paid: number;
      sats: string;
    }>(sql`
      select
        date_trunc('day', created_at)::date::text as day,
        count(*)::int as total,
        count(*) filter (where status in ('pago','pago_tardio'))::int as paid,
        coalesce(sum(amount_sats), 0)::text as sats
      from payment_intents
      where client_id = ${clientId} and created_at >= ${since.toISOString()}::timestamptz
      group by 1
      order by 1
    `);
    return rows.map((row) => ({ day: row.day, total: row.total, paid: row.paid, sats: row.sats }));
  }
}