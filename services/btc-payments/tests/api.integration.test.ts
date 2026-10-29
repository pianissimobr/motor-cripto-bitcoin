import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountXpub } from '../src/adapters/hd/derivation.js';
import type { LnbitsClient } from '../src/adapters/lnbits/client.js';
import type { AppConfig } from '../src/config.js';
import { signRequest } from '../src/crypto/hmac.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { silentLogger } from '../src/logger.js';
import { buildApp } from '../src/http/app.js';
import { ClientService } from '../src/services/client-service.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import { testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

class FakeLnbits {
  private readonly invoices = new Map<string, { amountSats: bigint; paid: boolean }>();
  private counter = 0;

  async createInvoice(input: { amountSats: bigint }) {
    const paymentHash = `api-hash-${++this.counter}`;
    this.invoices.set(paymentHash, { amountSats: input.amountSats, paid: false });
    return {
      payment_hash: paymentHash,
      payment_request: `lnbc-api-${paymentHash}`,
    };
  }

  async getPayment(paymentHash: string) {
    const invoice = this.invoices.get(paymentHash);
    if (!invoice) throw new Error('invoice desconhecida');
    return {
      payment_hash: paymentHash,
      paid: invoice.paid,
      pending: !invoice.paid,
      status: invoice.paid ? 'paid' : 'pending',
      amount_sats: Number(invoice.amountSats),
    };
  }

  markPaid(paymentHash: string): void {
    const invoice = this.invoices.get(paymentHash);
    if (invoice) invoice.paid = true;
  }
}

maybeDescribe('API (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let lnbits: FakeLnbits;
  let paymentIntents: PaymentIntentService;
  let clients: ClientService;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig();
    const xpub = parseAccountXpub(config.btc.xpub, config.btc.network);
    await repos.initHdWalletState({
      gapLimit: config.btc.gapLimit,
      xpubFingerprint: xpub.fingerprint,
    });
    lnbits = new FakeLnbits();
    paymentIntents = new PaymentIntentService({
      repos,
      lnbits: lnbits as unknown as LnbitsClient,
      config,
      xpub,
      logger: silentLogger,
    });
    clients = new ClientService({ repos, config, logger: silentLogger });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  function buildTestApp() {
    return buildApp({
      config,
      logger: silentLogger,
      readiness: { checks: [] },
      services: { config, logger: silentLogger, repos, paymentIntents, clients },
    });
  }

  function signedHeaders(
    apiKey: string,
    requestSecret: string,
    method: string,
    path: string,
    body: string,
    nonce = randomUUID(),
  ) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signRequest(requestSecret, {
      method,
      path,
      timestamp,
      nonce,
      body,
    });
    return {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    };
  }

  async function createApiClient(app: ReturnType<typeof buildTestApp>) {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/clients',
      headers: { authorization: `Bearer ${config.server.adminToken}` },
      payload: { name: 'api test', webhook_url: 'http://localhost:9999/webhook' },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      apiKey: string;
      requestSecret: string;
      webhookSecret: string;
    };
  }

  it('exige admin token e cria cliente', async () => {
    const app = buildTestApp();
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/admin/api/clients',
      payload: { name: 'x', webhook_url: 'http://localhost:9999/webhook' },
    });
    expect(unauthorized.statusCode).toBe(401);

    const created = await createApiClient(app);
    expect(created.apiKey).toMatch(/^mk_btc_live_/);
    expect(created.requestSecret.length).toBeGreaterThan(20);

    const status = await app.inject({
      method: 'GET',
      url: '/admin/api/status',
      headers: { authorization: `Bearer ${config.server.adminToken}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().ok).toBe(true);

    const webhooks = await app.inject({
      method: 'GET',
      url: '/admin/api/webhooks',
      headers: { authorization: `Bearer ${config.server.adminToken}` },
    });
    expect(webhooks.statusCode).toBe(200);
    expect(Array.isArray(webhooks.json())).toBe(true);
    await app.close();
  });

  it('cria e consulta intent com HMAC e rejeita replay/assinatura ruim', async () => {
    const app = buildTestApp();
    const created = await createApiClient(app);
    const body = JSON.stringify({
      external_id: 'api-1',
      amount_sats: 1000,
      description: 'API test',
    });
    const headers = signedHeaders(
      created.apiKey,
      created.requestSecret,
      'POST',
      '/v1/payment-intents',
      body,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/payment-intents',
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    const intent = response.json();
    expect(intent.external_id).toBe('api-1');
    expect(intent.lightning.payment_hash).toBe('api-hash-1');
    expect(intent.onchain.address).toMatch(/^bcrt1q/);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/payment-intents',
      headers,
      payload: body,
    });
    expect(replay.statusCode).toBe(401);

    const badSignature = await app.inject({
      method: 'POST',
      url: '/v1/payment-intents',
      headers: signedHeaders(
        created.apiKey,
        'segredo-errado',
        'POST',
        '/v1/payment-intents',
        body,
      ),
      payload: body,
    });
    expect(badSignature.statusCode).toBe(401);

    const getHeaders = signedHeaders(
      created.apiKey,
      created.requestSecret,
      'GET',
      `/v1/payment-intents/${intent.id}`,
      '',
    );
    const getResponse = await app.inject({
      method: 'GET',
      url: `/v1/payment-intents/${intent.id}`,
      headers: getHeaders,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().id).toBe(intent.id);
    await app.close();
  });

  it('processa webhook LNbits com corpo duplamente serializado', async () => {
    const app = buildTestApp();
    const created = await createApiClient(app);
    const body = JSON.stringify({
      external_id: 'api-2',
      amount_sats: 1000,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/payment-intents',
      headers: signedHeaders(
        created.apiKey,
        created.requestSecret,
        'POST',
        '/v1/payment-intents',
        body,
      ),
      payload: body,
    });
    const intent = response.json();
    const paymentHash = intent.lightning.payment_hash as string;
    lnbits.markPaid(paymentHash);

    // A versao 1.6 do LNbits envia payment.json(), que e uma string JSON.
    const webhookBody = JSON.stringify(
      JSON.stringify({
        checking_id: paymentHash,
        payment_hash: paymentHash,
        amount: 1_000_000,
        paid: true,
        status: 'success',
      }),
    );
    const webhook = await app.inject({
      method: 'POST',
      url: `/webhooks/lnbits?token=${config.lightning.webhookToken}`,
      headers: { 'content-type': 'application/json' },
      payload: webhookBody,
    });
    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toMatchObject({
      status: 'pago',
      valor: '1000',
      id_transacao: 'api-2',
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: `/v1/payment-intents/${intent.id}`,
      headers: signedHeaders(
        created.apiKey,
        created.requestSecret,
        'GET',
        `/v1/payment-intents/${intent.id}`,
        '',
      ),
    });
    expect(getResponse.json().status).toBe('pago');

    const events = await app.inject({
      method: 'GET',
      url: '/admin/api/webhooks',
      headers: { authorization: `Bearer ${config.server.adminToken}` },
    });
    const eventId = (events.json() as Array<{ id: string }>)[0]?.id;
    expect(eventId).toBeTruthy();
    const replay = await app.inject({
      method: 'POST',
      url: `/admin/api/webhooks/${eventId}/replay`,
      headers: { authorization: `Bearer ${config.server.adminToken}` },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe('pendente');
    await app.close();
  });
});
