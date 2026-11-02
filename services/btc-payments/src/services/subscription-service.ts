import type { Repositories } from '../db/repositories.js';
import { ValidationError } from '../domain/errors.js';
import type { Subscription, SubscriptionInterval } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { PaymentIntentService } from './payment-intent-service.js';
import type { AlertService } from './alert-service.js';

export type SubscriptionServiceDeps = {
  repos: Repositories;
  paymentIntents: PaymentIntentService;
  logger: Logger;
  alerts?: AlertService;
  now?: () => Date;
};

export type CreateSubscriptionInput = {
  merchantId: string;
  name: string;
  amountSats: bigint;
  description?: string | null;
  interval: SubscriptionInterval;
  externalId?: string | null;
  metadata?: Record<string, unknown> | null;
  startAt?: Date;
};

export class SubscriptionService {
  constructor(private readonly deps: SubscriptionServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  addInterval(from: Date, interval: SubscriptionInterval): Date {
    const next = new Date(from.getTime());
    if (interval === 'day') next.setUTCDate(next.getUTCDate() + 1);
    else if (interval === 'week') next.setUTCDate(next.getUTCDate() + 7);
    else next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
  }

  async create(input: CreateSubscriptionInput): Promise<Subscription> {
    if (input.amountSats <= 0n) {
      throw new ValidationError('amount_sats precisa ser positivo');
    }
    const subscription = await this.deps.repos.createSubscription({
      merchantId: input.merchantId,
      name: input.name,
      amountSats: input.amountSats,
      description: input.description ?? null,
      interval: input.interval,
      externalId: input.externalId ?? null,
      metadata: input.metadata ?? null,
      nextChargeAt: input.startAt ?? this.now(),
    });
    await this.deps.repos.insertAuditEvent({
      actor: 'portal',
      action: 'subscription.created',
      entity: 'subscription',
      entityId: subscription.id,
      metadata: { merchantId: input.merchantId },
    });
    return subscription;
  }

  async runCycle(limit: number): Promise<{ due: number; charged: number; failed: number }> {
    const due = await this.deps.repos.listDueSubscriptions(this.now(), limit);
    let charged = 0;
    let failed = 0;

    for (const subscription of due) {
      try {
        const periodStart = subscription.nextChargeAt;
        const periodEnd = this.addInterval(periodStart, subscription.interval);
        const created = await this.deps.paymentIntents.create({
          clientId: subscription.merchantId,
          externalId: `sub_${subscription.id}_${periodEnd.getTime()}`,
          amountSats: subscription.amountSats,
          description: subscription.description ?? subscription.name,
          metadata: {
            subscription_id: subscription.id,
            period_start: periodStart.toISOString(),
            period_end: periodEnd.toISOString(),
            ...(subscription.metadata ?? {}),
          },
        });
        await this.deps.repos.createSubscriptionCharge({
          subscriptionId: subscription.id,
          intentId: created.dto.id,
          periodStart,
          periodEnd,
        });
        await this.deps.repos.updateSubscription(subscription.id, {
          nextChargeAt: periodEnd,
        });
        charged++;
      } catch (err) {
        failed++;
        await this.deps.repos.updateSubscription(subscription.id, {
          status: 'falha',
        });
        this.deps.logger.error(
          { err, subscriptionId: subscription.id },
          'falha ao gerar ciclo da assinatura',
        );
        await this.deps.alerts?.send({
          level: 'error',
          title: 'falha ao gerar ciclo de assinatura',
          message: err instanceof Error ? err.message : String(err),
          metadata: { subscriptionId: subscription.id },
        });
      }
    }

    await this.syncCharges(limit);
    return { due: due.length, charged, failed };
  }

  async syncCharges(limit: number): Promise<number> {
    const charges = await this.deps.repos.listSubscriptionChargesByStatus('criada', limit);
    let updated = 0;
    for (const charge of charges) {
      if (!charge.intentId) continue;
      const intent = await this.deps.repos.findIntentById(charge.intentId);
      if (!intent) continue;
      if (intent.status === 'pago' || intent.status === 'pago_tardio') {
        await this.deps.repos.markSubscriptionCharge(charge.id, 'paga');
        updated++;
      } else if (
        intent.status === 'expirado' ||
        intent.status === 'cancelado' ||
        intent.status === 'falha_criacao'
      ) {
        await this.deps.repos.markSubscriptionCharge(charge.id, 'falhou');
        updated++;
      }
    }
    return updated;
  }

  async pause(id: string): Promise<Subscription> {
    const subscription = await this.deps.repos.findSubscriptionById(id);
    if (!subscription) throw new ValidationError('assinatura nao encontrada');
    return (await this.deps.repos.updateSubscription(id, { status: 'pausada' }))!;
  }

  async resume(id: string): Promise<Subscription> {
    const subscription = await this.deps.repos.findSubscriptionById(id);
    if (!subscription) throw new ValidationError('assinatura nao encontrada');
    const nextChargeAt =
      subscription.nextChargeAt.getTime() < this.now().getTime()
        ? this.now()
        : subscription.nextChargeAt;
    return (await this.deps.repos.updateSubscription(id, {
      status: 'ativa',
      nextChargeAt,
    }))!;
  }

  async cancel(id: string): Promise<Subscription> {
    const subscription = await this.deps.repos.findSubscriptionById(id);
    if (!subscription) throw new ValidationError('assinatura nao encontrada');
    return (await this.deps.repos.updateSubscription(id, { status: 'cancelada' }))!;
  }
}