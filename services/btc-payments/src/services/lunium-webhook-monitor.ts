import type { LuniumClient } from '../adapters/lunium/client.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';

/**
 * Vigia as entregas de webhook da Lunium para o motor.
 *
 * O estado das cobrancas nao depende so do webhook (o reconcile consulta o
 * feed e a Lunium), mas webhook que esgota as 12 tentativas quer dizer que
 * algo entre a Lunium e o motor esta quebrado (URL, certificado, firewall).
 * O job pede um reenvio de cada entrega esgotada (uma vez) e avisa o time
 * se ainda houver falha, no maximo uma vez por hora.
 */
export class LuniumWebhookMonitor {
  private readonly retried = new Set<string>();
  private lastAlertAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly deps: {
      lunium: Pick<LuniumClient, 'listWebhookDeliveries' | 'retryWebhookDelivery'>;
      logger: Logger;
      alerts?: Pick<AlertService, 'send'>;
      now?: () => number;
    },
  ) {}

  async runCycle(): Promise<{ failed: number; retried: number; recovered: number }> {
    const now = this.deps.now?.() ?? Date.now();
    const { deliveries = [] } = await this.deps.lunium.listWebhookDeliveries({ status: 'failed', limit: 50 });
    // webhook.test nao importa; eventos desconhecidos tambem contam (a lista cresce).
    const failed = deliveries.filter((d) => d.status === 'failed' && d.event !== 'webhook.test');
    let retried = 0;
    let recovered = 0;
    for (const delivery of failed) {
      if (this.retried.has(delivery.event_id)) continue;
      this.retried.add(delivery.event_id);
      retried += 1;
      try {
        const result = await this.deps.lunium.retryWebhookDelivery(delivery.event_id);
        if (result.delivered) recovered += 1;
      } catch (err) {
        this.deps.logger.warn({ err, eventId: delivery.event_id }, 'reenvio de webhook da Lunium falhou');
      }
    }
    if (this.retried.size > 5_000) this.retried.clear();

    const stillFailing = failed.length - recovered;
    if (stillFailing > 0 && now - this.lastAlertAt > 3_600_000) {
      this.lastAlertAt = now;
      const sample = failed[0]!;
      await this.deps.alerts?.send({
        level: 'warn',
        title: 'A Lunium nao esta conseguindo entregar webhooks ao motor',
        message: `${stillFailing} entrega(s) esgotaram as tentativas. Ultimo erro: ${sample.last_error ?? 'desconhecido'}`,
        metadata: { failed: stillFailing, url: sample.url ?? null, event: sample.event, eventId: sample.event_id },
      });
    }
    return { failed: failed.length, retried, recovered };
  }
}
