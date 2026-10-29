import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/repositories.js';
import type { PaymentIntent } from '../domain/types.js';

export type IntentEventType =
  | 'payment_intent.paid'
  | 'payment_intent.paid_late'
  | 'payment_intent.partial'
  | 'payment_intent.expired'
  | 'payment_intent.canceled'
  | 'payment_intent.reorged';

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
