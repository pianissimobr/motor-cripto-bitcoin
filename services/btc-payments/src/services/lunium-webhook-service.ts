import type { AppConfig } from '../config.js';
import { ServiceUnavailableError } from '../domain/errors.js';
import type { LuniumClient } from '../adapters/lunium/client.js';
import type { Repositories } from '../db/repositories.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';
import type { PixChargeService } from './pix-charge-service.js';

export type LuniumWebhookServiceDeps = {
  repos: Repositories;
  lunium: LuniumClient;
  pixCharges: PixChargeService;
  config: AppConfig;
  logger: Logger;
  alerts?: AlertService;
};

export type LuniumWebhookReceiveInput = {
  signature: string | null;
  eventId: string | null;
  rawBody: string;
};

export class LuniumWebhookService {
  constructor(private readonly deps: LuniumWebhookServiceDeps) {}

  async receive(input: LuniumWebhookReceiveInput): Promise<{
    ok: true;
    duplicated: boolean;
  }> {
    if (!this.deps.config.pix.enabled) {
      throw new ServiceUnavailableError('PIX desabilitado');
    }
    const verified = this.deps.lunium.verifyWebhook({
      signature: input.signature,
      rawBody: input.rawBody,
      eventId: input.eventId,
      toleranceSeconds: 300,
    });
    const eventType =
      typeof verified.payload.event === 'string'
        ? verified.payload.event
        : 'unknown';
    const inserted = await this.deps.repos.insertProviderEvent({
      provider: 'lunium',
      eventType,
      externalId: verified.eventId,
      payload: verified.payload,
    });
    if (!inserted) return { ok: true, duplicated: true };

    this.deps.logger.info(
      { eventId: verified.eventId, eventType },
      'webhook Lunium persistido',
    );
    return { ok: true, duplicated: false };
  }

  async processPending(limit: number): Promise<{
    checked: number;
    processed: number;
    errors: number;
  }> {
    const events = await this.deps.repos.listUnprocessedProviderEvents(
      'lunium',
      limit,
    );
    let processed = 0;
    let errors = 0;

    for (const event of events) {
      try {
        const data = event.payload.data;
        const cashinId =
          data && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, unknown>).cashin_id
            : null;
        const charge =
          typeof cashinId === 'string'
            ? await this.deps.repos.findPixChargeByProviderChargeId(
                'lunium',
                cashinId,
              )
            : null;
        if (charge) {
          await this.deps.pixCharges.sync(charge.id);
        } else {
          this.deps.logger.warn(
            { eventId: event.externalId, eventType: event.eventType },
            'webhook Lunium sem cobranca local correspondente',
          );
        }
        await this.deps.repos.markProviderEventProcessed(event.id);
        processed++;
      } catch (err) {
        errors++;
        this.deps.logger.error(
          { err, eventId: event.externalId, eventType: event.eventType },
          'falha ao processar webhook Lunium',
        );
      }
    }

    return { checked: events.length, processed, errors };
  }
}
