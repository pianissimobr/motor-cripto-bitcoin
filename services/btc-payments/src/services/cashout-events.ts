import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/repositories.js';
import type { CashOutCharge } from '../domain/types.js';

export type CashOutEventType =
  | 'cashout.created'
  | 'cashout.awaiting_deposit'
  | 'cashout.deposit_detected'
  | 'cashout.paid'
  | 'cashout.settled'
  | 'cashout.expired'
  | 'cashout.refunded'
  | 'cashout.failed'
  | 'cashout.manual';

export function buildCashOutPayload(
  charge: CashOutCharge,
  eventType: CashOutEventType,
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
      provider_cashout_id: charge.providerCashoutId,
      status: charge.status,
      provider_state: charge.providerState,
      amount_brl_cents: charge.amountBrlCents.toString(),
      asset: charge.asset,
      network: charge.network,
      origin_address: charge.originAddress,
      deposit_address: charge.depositAddress,
      amount_asset_minor: charge.amountAssetMinor?.toString() ?? null,
      tx_hash: charge.txHash,
      pix_e2e: charge.pixE2e,
    },
  };
}

export async function enqueueCashOutEvent(
  deps: { repos: Repositories; now?: () => Date },
  charge: CashOutCharge,
  eventType: CashOutEventType,
  dedupeSuffix: string,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await deps.repos.insertWebhookEvent({
    clientId: charge.clientId,
    cashoutChargeId: charge.id,
    eventType,
    dedupeKey: `cashout:${charge.id}:${dedupeSuffix}`,
    payload: buildCashOutPayload(charge, eventType, now),
  });
}
