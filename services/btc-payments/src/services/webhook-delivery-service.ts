import type { AppConfig } from '../config.js';
import { decryptSecret } from '../crypto/cipher.js';
import { signWebhook } from '../crypto/hmac.js';
import type { Repositories } from '../db/repositories.js';
import type { WebhookEvent } from '../domain/types.js';
import type { Logger } from '../logger.js';

const BACKOFF_SECONDS = [60, 300, 1_800, 7_200, 21_600, 86_400];

import { createSafeFetch } from '../net/safe-fetch.js';

export type WebhookDeliveryDeps = {
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type WebhookDeliveryResult = {
  checked: number;
  delivered: number;
  failed: number;
  finalFailures: number;
};

export class WebhookDeliveryService {
  /** A URL do webhook vem da loja: a entrega tambem bloqueia a rede interna. */
  private readonly safeFetch: typeof fetch;

  constructor(private readonly deps: WebhookDeliveryDeps) {
    this.safeFetch = createSafeFetch({
      allowLoopback: !deps.config.service.isProduction,
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async runCycle(
    limit = this.deps.config.jobs.batchSize,
  ): Promise<WebhookDeliveryResult> {
    const now = this.now();
    const events = await this.deps.repos.listDueWebhookEvents(now, limit);
    const result: WebhookDeliveryResult = {
      checked: events.length,
      delivered: 0,
      failed: 0,
      finalFailures: 0,
    };

    for (const event of events) {
      try {
        const outcome = await this.deliver(event, now);
        if (outcome === 'delivered') result.delivered++;
        else {
          result.failed++;
          if (outcome === 'final') result.finalFailures++;
        }
      } catch (err) {
        result.failed++;
        this.deps.logger.error(
          { err, eventId: event.id },
          'erro inesperado ao entregar webhook',
        );
      }
    }

    return result;
  }

  private async deliver(
    event: WebhookEvent,
    now: Date,
  ): Promise<'delivered' | 'retry' | 'final'> {
    const client = await this.deps.repos.findClientById(event.clientId);
    if (!client || client.status !== 'ativo') {
      return this.fail(event, now, 'cliente da API inexistente ou inativo');
    }
    // IPN de fatura: URL e segredo proprios (da chave de loja).
    const targetUrl = event.targetUrl?.trim() || client.webhookUrl.trim();
    if (!targetUrl) {
      await this.deps.repos.markWebhookDelivered(event.id);
      this.deps.logger.debug(
        { eventId: event.id, clientId: client.id },
        'webhook descartado: cliente sem webhook_url configurado',
      );
      return 'delivered';
    }

    let secret: string;
    try {
      const storeKey = event.storeKeyId
        ? await this.deps.repos.findStoreKeyById(event.storeKeyId)
        : null;
      secret = storeKey
        ? decryptSecret(storeKey.ipnSecretEnc, this.deps.config.crypto.keyring, storeKey.id)
        : decryptSecret(client.webhookSecretEnc, this.deps.config.crypto.keyring, client.id);
    } catch (err) {
      this.deps.logger.error(
        { err, clientId: client.id },
        'falha ao decifrar webhook secret',
      );
      return this.fail(event, now, 'webhook secret indecifravel');
    }

    const body = JSON.stringify(event.payload);
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = signWebhook(secret, timestamp, body);
    const fetchImpl = this.deps.fetchImpl ?? this.safeFetch;

    let statusCode = 0;
    let errorMessage: string | null = null;
    try {
      const response = await fetchImpl(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'btc-payments-webhook/1',
          'x-webhook-signature': signature,
          'x-webhook-event': event.eventType,
          'x-webhook-delivery': event.id,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.deps.config.webhook.timeoutMs),
      });
      statusCode = response.status;
      if (!response.ok) errorMessage = `HTTP ${response.status}`;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    if (statusCode >= 200 && statusCode < 300) {
      await this.deps.repos.markWebhookDelivered(event.id);
      this.deps.logger.info(
        { eventId: event.id, intentId: event.intentId, statusCode },
        'webhook entregue',
      );
      return 'delivered';
    }

    return this.fail(event, now, errorMessage ?? `HTTP ${statusCode}`);
  }

  private async fail(
    event: WebhookEvent,
    now: Date,
    message: string,
  ): Promise<'final' | 'retry'> {
    const attempts = event.attempts + 1;
    const final = attempts >= this.deps.config.webhook.maxAttempts;
    const backoff =
      BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]!;
    const nextAttemptAt = final
      ? now
      : new Date(now.getTime() + backoff * 1000);
    await this.deps.repos.markWebhookFailed({
      id: event.id,
      attempts,
      nextAttemptAt,
      lastError: message,
      final,
    });
    this.deps.logger.warn(
      { eventId: event.id, attempts, final, error: message },
      'falha ao entregar webhook',
    );
    return final ? 'final' : 'retry';
  }
}
