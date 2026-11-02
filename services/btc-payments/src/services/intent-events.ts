import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/repositories.js';
import type { PaymentIntent } from '../domain/types.js';

export type IntentEventType =
  | 'payment_intent.paid'
  | 'payment_intent.paid_late'
  | 'payment_intent.partial'
  | 'payment_intent.expired'
  | 'payment_intent.canceled'
  | 'payment_intent.reorged'
  | 'payment_intent.converted'
  | 'payment_intent.conversion_failed'
  | 'payment_intent.conversion_refunded'
  | 'payment_intent.payout_pending'
  | 'payment_intent.payout_sent'
  | 'payment_intent.payout_confirmed'
  | 'payment_intent.payout_failed';

export function buildIntentEventPayload(
  intent: PaymentIntent,
  eventType: IntentEventType,
  createdAt: Date,
): Record<string, unknown> {
  return {
    event: eventType,
    event_id: randomUUID(),
    created_at: createdAt.toISOString(),
    data: {
      id: intent.id,
      external_id: intent.externalId,
      status: intent.status,
      amount_sats: intent.amountSats.toString(),
      paid_amount_sats: intent.paidAmountSats?.toString() ?? null,
      paid_rail: intent.paidRail,
      paid_at: intent.paidAt?.toISOString() ?? null,
      overpaid_sats: intent.overpaidSats?.toString() ?? null,
    },
  };
}

export async function enqueueIntentEvent(
  deps: {
    repos: Repositories;
    now?: () => Date;
  },
  intent: PaymentIntent,
  eventType: IntentEventType,
  dedupeSuffix: string,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await deps.repos.insertWebhookEvent({
    clientId: intent.clientId,
    intentId: intent.id,
    eventType,
    dedupeKey: `intent:${intent.id}:${dedupeSuffix}:${intent.version}`,
    payload: buildIntentEventPayload(intent, eventType, now),
  });
}

export async function enqueueSettlementEvent(
  deps: {
    repos: Repositories;
    now?: () => Date;
  },
  input: {
    intentId: string;
    eventType: IntentEventType;
    dedupeSuffix: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  const intent = await deps.repos.findIntentById(input.intentId);
  if (!intent) return;
  const now = deps.now?.() ?? new Date();
  await deps.repos.insertWebhookEvent({
    clientId: intent.clientId,
    intentId: intent.id,
    eventType: input.eventType,
    dedupeKey: `intent:${intent.id}:${input.dedupeSuffix}`,
    payload: {
      event: input.eventType,
      event_id: randomUUID(),
      created_at: now.toISOString(),
      data: {
        id: intent.id,
        external_id: intent.externalId,
        status: intent.status,
        settlement_status: intent.settlementStatus,
        amount_sats: intent.amountSats.toString(),
        paid_amount_sats: intent.paidAmountSats?.toString() ?? null,
        ...(input.data ?? {}),
      },
    },
  });
}
