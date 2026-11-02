import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/repositories.js';
import type { PixCharge } from '../domain/types.js';

export type PixChargeEventType =
  | 'pix_charge.created'
  | 'pix_charge.paid'
  | 'pix_charge.settled'
  | 'pix_charge.expired'
  | 'pix_charge.refunded'
  | 'pix_charge.failed'
  | 'pix_charge.payout_pending'
  | 'pix_charge.payout_sent'
  | 'pix_charge.payout_confirmed'
  | 'pix_charge.payout_failed';

export function buildPixChargePayload(
  charge: PixCharge,
  eventType: PixChargeEventType,
  createdAt: Date,
): Record<string, unknown> {
  return {
    event: eventType,
    event_id: randomUUID(),
    created_at: createdAt.toISOString(),
    data: {
      id: charge.id,
      external_id: charge.externalId,
      provider: charge.provider,
      provider_charge_id: charge.providerChargeId,
      status: charge.status,
      settlement_status: charge.settlementStatus,
      amount_brl_cents: charge.amountBrlCents.toString(),
      asset: charge.asset,
      chain: charge.chain,
      asset_amount_minor: charge.assetAmountMinor?.toString() ?? null,
      settlement_tx_hash: charge.settlementTxHash,
      payout_id: charge.payoutId,
    },
  };
}

export async function enqueuePixChargeEvent(
  deps: { repos: Repositories; now?: () => Date },
  charge: PixCharge,
  eventType: PixChargeEventType,
  dedupeSuffix: string,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await deps.repos.insertWebhookEvent({
    clientId: charge.clientId,
    pixChargeId: charge.id,
    eventType,
    dedupeKey: `pix_charge:${charge.id}:${dedupeSuffix}`,
    payload: buildPixChargePayload(charge, eventType, now),
  });
}
