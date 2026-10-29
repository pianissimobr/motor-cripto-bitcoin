import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { verifyWebhookSignature } from '../src/crypto/hmac.js';
import { silentLogger } from '../src/logger.js';
import { WebhookDeliveryService } from '../src/services/webhook-delivery-service.js';
import {
  createTestClient,
  testConfig,
  truncateAll,
  type TestClient,
} from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

maybeDescribe('webhook delivery (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let client: TestClient;
  const now = new Date(Date.now() + 5_000);

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig();
    client = await createTestClient(repos, config);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function seedEvent() {
    const intentId = crypto.randomUUID();
    // A tabela tem FK para payment_intents; cria uma intent minima via SQL
    // para manter o teste focado na entrega do webhook.
    await db.sql`
      insert into payment_intents
        (id, client_id, external_id, amount_sats, status, expires_at, grace_until)
      values
        (${intentId}, ${client.client.id}, ${'evt-' + intentId}, 1000, 'pago', now(), now())
    `;
    const event = await repos.insertWebhookEvent({
      clientId: client.client.id,
      intentId,
      eventType: 'payment_intent.paid',
      dedupeKey: `intent:${intentId}:paid`,
      payload: {
        event: 'payment_intent.paid',
        event_id: 'evt-1',
        created_at: now.toISOString(),
        data: { id: intentId, status: 'pago', amount_sats: '1000' },
      },
    });
    if (!event) throw new Error('evento nao criado');
    return event;
  }

  it('entrega assinada e marca como entregue', async () => {
    const event = await seedEvent();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const service = new WebhookDeliveryService({
      repos,
      config,
      logger: silentLogger,
      fetchImpl,
      now: () => now,
    });
    const result = await service.runCycle(10);
    expect(result).toMatchObject({ checked: 1, delivered: 1, failed: 0 });
    expect(calls).toHaveLength(1);

    const headers = calls[0]!.init.headers as Record<string, string>;
    const body = calls[0]!.init.body as string;
    expect(headers['x-webhook-event']).toBe('payment_intent.paid');
    expect(headers['x-webhook-delivery']).toBe(event.id);
    const parsed = Object.fromEntries(
      headers['x-webhook-signature']!.split(',').map((p) => p.split('=')),
    );
    expect(
      verifyWebhookSignature({
        secret: client.webhookSecret,
        header: headers['x-webhook-signature']!,
        body,
        nowSeconds: Number(parsed.t),
      }),
    ).toBe(true);

    const [stored] = await db.sql`
      select status, attempts from webhook_events where id = ${event.id}
    `;
    expect(stored?.status).toBe('entregue');
    expect(stored?.attempts).toBe(1);
  });

  it('falha, aplica retry e marca como falhou ao atingir o limite', async () => {
    await seedEvent();
    const failingConfig: AppConfig = {
      ...config,
      webhook: { ...config.webhook, maxAttempts: 1 },
    };
    const fetchImpl = (async () =>
      new Response('erro', { status: 500 })) as typeof fetch;
    const service = new WebhookDeliveryService({
      repos,
      config: failingConfig,
      logger: silentLogger,
      fetchImpl,
      now: () => now,
    });
    const result = await service.runCycle(10);
    expect(result).toMatchObject({ checked: 1, delivered: 0, failed: 1 });
    const [stored] = await db.sql`
      select status, attempts, last_error from webhook_events
    `;
    expect(stored?.status).toBe('falhou');
    expect(stored?.attempts).toBe(1);
    expect(stored?.last_error).toContain('HTTP 500');
  });
});
