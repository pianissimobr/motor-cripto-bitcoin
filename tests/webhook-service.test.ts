import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { setupCore } from './core-fixtures.js';
import { signWebhook, WebhookService } from '../src/core/services/webhook-service.js';

describe('WebhookService', () => {
  it('entrega payload assinado e marca como entregue', async () => {
    const { repos, links, created, profile, wallet } = await setupCore();
    const { link } = await links.create({
      apiClienteId: created.client.id,
      externalId: 'pedido-hook',
      amountCents: 1_000,
      rampProfileId: profile.id,
      walletId: wallet.id,
    });
    const now = new Date('2026-10-23T12:00:00.000Z');
    let captured: { url: string; init: RequestInit } | null = null;
    const service = new WebhookService({
      repos,
      logger: silentLogger,
      timeoutMs: 1_000,
      maxAttempts: 3,
      now: () => now,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });

    await service.enqueueForLink({ ...link, status: 'pago' }, 'pago');
    expect(repos.webhooks.rows).toHaveLength(1);

    const result = await service.runCycle();
    expect(result).toMatchObject({ tentativas: 1, entregues: 1, falhas: 0 });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://example.test/webhook');

    const headers = captured!.init.headers as Record<string, string>;
    const event = repos.webhooks.rows[0]!;
    expect(headers['x-webhook-event']).toBe('realizado');
    expect(headers['x-webhook-delivery']).toBe(event.id);
    expect(headers['x-webhook-signature']).toBe(
      signWebhook(created.client.webhookSecret, Math.floor(now.getTime() / 1000), event.payload),
    );
    expect(event.status).toBe('entregue');
    expect(event.deliveredEm).not.toBeNull();
  });

  it('agenda retry com backoff e desiste no maximo de tentativas', async () => {
    const { repos, links, created, profile, wallet } = await setupCore();
    const { link } = await links.create({
      apiClienteId: created.client.id,
      externalId: 'pedido-retry',
      amountCents: 1_000,
      rampProfileId: profile.id,
      walletId: wallet.id,
    });
    let now = new Date('2026-10-23T12:00:00.000Z');
    const service = new WebhookService({
      repos,
      logger: silentLogger,
      timeoutMs: 1_000,
      maxAttempts: 2,
      now: () => now,
      fetchImpl: (async () => new Response('erro', { status: 500 })) as typeof fetch,
    });

    await service.enqueueForLink({ ...link, status: 'pago' }, 'pago');
    await service.runCycle();
    const event = repos.webhooks.rows[0]!;
    expect(event.status).toBe('pendente');
    expect(event.attempts).toBe(1);
    expect(event.nextAttemptEm.getTime()).toBe(now.getTime() + 60_000);

    now = new Date(now.getTime() + 61_000);
    await service.runCycle();
    expect(event.status).toBe('falhou');
    expect(event.attempts).toBe(2);
    expect(event.lastError).toBe('HTTP 500');
  });

  it('replay recoloca evento falho na fila', async () => {
    const { repos, links, created, profile, wallet } = await setupCore();
    const { link } = await links.create({
      apiClienteId: created.client.id,
      externalId: 'pedido-replay',
      amountCents: 1_000,
      rampProfileId: profile.id,
      walletId: wallet.id,
    });
    const now = new Date('2026-10-23T12:00:00.000Z');
    const service = new WebhookService({
      repos,
      logger: silentLogger,
      timeoutMs: 1_000,
      maxAttempts: 1,
      now: () => now,
      fetchImpl: (async () => new Response('erro', { status: 500 })) as typeof fetch,
    });
    await service.enqueueForLink({ ...link, status: 'nao_realizado' }, 'nao_realizado');
    await service.runCycle();
    const failed = repos.webhooks.rows[0]!;
    expect(failed.status).toBe('falhou');

    const replayed = await service.replay(failed.id);
    expect(replayed?.status).toBe('pendente');
    expect(replayed?.attempts).toBe(0);
    expect(replayed?.nextAttemptEm).toEqual(now);
  });
});
