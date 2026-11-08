import { createHmac, generateKeyPairSync, createHash, createSign } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { invoices as invoicesTable, nuvemshopPayments, nuvemshopStores } from '../src/db/schema.js';
import { buildApp } from '../src/http/app.js';
import { silentLogger } from '../src/logger.js';
import { InvoiceService } from '../src/services/invoice-service.js';
import { NuvemshopService } from '../src/services/nuvemshop-service.js';
import { createTestClient, testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;
const SECRET = 'segredo-do-app-nuvemshop';

type Call = { url: string; method: string; body: unknown; auth?: string | undefined };

/** API da Nuvemshop falsa: grava as chamadas e responde como a documentacao. */
function fakeNuvemshop() {
  const calls: Call[] = [];
  const orders = new Map<string, Record<string, unknown>>();
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body, auth: init.headers.authorization });
    const reply = (status: number, data: unknown) => ({ status, json: async () => data });
    if (url.endsWith('/apps/authorize/token')) {
      return body.code === 'code-ok' ? reply(200, { access_token: 'tok-loja', token_type: 'bearer', scope: 'write_payments', user_id: '777' }) : reply(400, {});
    }
    if (url.endsWith('/payment_providers')) return reply(201, { id: 'prov-1' });
    if (url.endsWith('/webhooks')) return reply(201, { id: 1 });
    const order = /\/orders\/(\d+)$/.exec(url);
    if (order && init.method === 'GET') return reply(orders.has(order[1]!) ? 200 : 404, orders.get(order[1]!) ?? {});
    if (/\/orders\/\d+\/transactions$/.test(url)) return reply(201, { id: 'trx-1', status: body.first_event.status === 'success' ? 'paid' : 'pending' });
    if (/\/transactions\/trx-1\/events$/.test(url)) return reply(201, { id: 'ev-1' });
    return reply(404, {});
  };
  return { calls, orders, fetchImpl };
}

maybeDescribe('Nuvemshop: app de pagamento (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let api: ReturnType<typeof fakeNuvemshop>;
  let invoices: InvoiceService;
  let nuvemshop: NuvemshopService;
  let app: FastifyInstance;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({
      RATE_LIMIT_MAX: '1000',
      PUBLIC_BASE_URL: 'https://pay.example.com',
      NUVEMSHOP_APP_ID: '4242',
      NUVEMSHOP_CLIENT_ID: '4242',
      NUVEMSHOP_CLIENT_SECRET: SECRET,
      NUVEMSHOP_PROVIDER_TAX_ID: '12.345.678/0001-99',
    });
    api = fakeNuvemshop();
    invoices = new InvoiceService({ db: db.db, repos, config, logger: silentLogger });
    nuvemshop = new NuvemshopService({ db: db.db, repos, config, logger: silentLogger, invoices, fetchImpl: api.fetchImpl as never });
    app = buildApp({
      config,
      logger: silentLogger,
      readiness: { checks: [] },
      services: { config, logger: silentLogger, repos, invoices, nuvemshop } as never,
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function installed() {
    const { client } = await createTestClient(repos, config);
    await db.db.execute(
      `insert into merchant_wallets (merchant_id, kind, purpose, chain, network, address, status, is_default)
       values ('${client.id}', 'usdc_settlement', 'loja', 'polygon', 'polygon', '0x4cd01696cd0165d6020ab7d8ae866fdf2fed3855', 'ativo', true)` as never,
    );
    const url = new URL(nuvemshop.authorizeUrl(client.id));
    const res = await app.inject({ method: 'GET', url: `/integrations/nuvemshop/callback?code=code-ok&state=${encodeURIComponent(url.searchParams.get('state')!)}` });
    expect(res.headers.location).toBe('https://pay.example.com/painel/integracao?nuvemshop=ok');
    return client;
  }

  const process = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/integrations/nuvemshop/process', payload: payload as never });

  it('instala: troca o code, registra o provedor e os webhooks; state adulterado falha', async () => {
    const client = await installed();
    const provider = api.calls.find((c) => c.url.endsWith('/payment_providers'))!;
    expect(provider.url).toBe('https://api.tiendanube.com/2025-03/777/payment_providers');
    expect(provider.auth).toBe('Bearer tok-loja');
    expect(provider.body).toMatchObject({
      checkout_js_url: 'https://pay.example.com/integrations/nuvemshop/checkout.js',
      checkout_payment_options: [expect.objectContaining({ id: 'libreflow_redirect', integration_type: 'redirect' })],
    });
    expect(api.calls.filter((c) => c.url.endsWith('/webhooks')).map((c) => (c.body as { event: string }).event)).toContain('order/created');
    const [store] = await db.db.select().from(nuvemshopStores);
    expect(store).toMatchObject({ storeId: '777', clientId: client.id, paymentProviderId: 'prov-1' });
    expect(store!.accessTokenEnc).not.toContain('tok-loja');

    const state = new URL(nuvemshop.authorizeUrl(client.id)).searchParams.get('state')!;
    const bad = await app.inject({ method: 'GET', url: `/integrations/nuvemshop/callback?code=code-ok&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}` });
    expect(bad.headers.location).toContain('nuvemshop=erro');
  });

  it('pagamento: cria a fatura, devolve o redirect e liga o pedido; pago vira transacao', async () => {
    await installed();
    const payload = {
      store_id: 777,
      cartId: 555,
      prices: { total: '149.70', currency: 'BRL' },
      payment: { attemptId: 'attempt-0001' },
      customer: { email: 'Cliente@Exemplo.com' },
      extra: { success_url: 'https://loja.example.com/checkout/success', cancel_url: 'javascript:alert(1)' },
    };
    const res = await process(payload);
    expect(res.statusCode).toBe(201);
    const { redirect_url, invoice_id } = res.json();
    expect(redirect_url).toBe(`https://pay.example.com/i/${invoice_id}`);
    // Mesma tentativa: mesma fatura.
    expect((await process(payload)).json().invoice_id).toBe(invoice_id);
    const [inv] = await db.db.select().from(invoicesTable).where(eq(invoicesTable.id, invoice_id));
    expect(inv).toMatchObject({ successUrl: 'https://loja.example.com/checkout/success', cancelUrl: null, amountCents: 14_970n });

    // Pedido de outro valor nao liga; o certo liga.
    api.orders.set('9001', { id: 9001, total: '10.00', contact_email: 'cliente@exemplo.com', gateway: 'prov-1' });
    expect(await nuvemshop.onOrderCreated('777', '9001')).toBe(false);
    api.orders.set('9002', { id: 9002, total: '149.70', contact_email: 'cliente@exemplo.com', gateway: 'prov-1' });
    expect(await nuvemshop.onOrderCreated('777', '9002')).toBe(true);

    await nuvemshop.runSyncCycle();
    const trx = api.calls.find((c) => c.url.endsWith('/orders/9002/transactions'))!;
    expect(trx.body).toMatchObject({
      payment_provider_id: 'prov-1',
      payment_attempt_id: 'attempt-0001',
      payment_provider_tax_id: '12.345.678/0001-99',
      first_event: { amount: { value: '149.70', currency: 'BRL' }, type: 'sale', status: 'pending' },
    });

    await db.db.update(invoicesTable).set({ status: 'pago', paidRail: 'pix_direto', txHash: 'E123', paidAt: new Date() }).where(eq(invoicesTable.id, invoice_id));
    await nuvemshop.runSyncCycle();
    const event = api.calls.find((c) => c.url.endsWith('/transactions/trx-1/events'))!;
    expect(event.body).toMatchObject({ type: 'sale', status: 'success', authorization_code: 'E123' });
    const [row] = await db.db.select().from(nuvemshopPayments);
    expect(row).toMatchObject({ reportedStatus: 'success', orderId: '9002', transactionId: 'trx-1' });
    // Nada mais a avisar.
    const before = api.calls.length;
    await nuvemshop.runSyncCycle();
    expect(api.calls.length).toBe(before);
  });

  it('cancelamento e idempotente; webhook exige o HMAC do app', async () => {
    await installed();
    const res = await process({ store_id: 777, cartId: 1, prices: { total: 20, currency: 'BRL' }, payment: { attemptId: 'attempt-0002' } });
    const id = res.json().invoice_id;
    for (let i = 0; i < 2; i++) {
      const cancel = await app.inject({ method: 'POST', url: '/integrations/nuvemshop/cancel?payment_attempt_id=attempt-0002' });
      expect(cancel.statusCode).toBe(200);
    }
    expect((await invoices.findPublic(id))!.status).toBe('cancelado');

    const body = JSON.stringify({ store_id: 777, event: 'app/uninstalled', id: 777 });
    const forged = await app.inject({ method: 'POST', url: '/integrations/nuvemshop/webhook', headers: { 'content-type': 'application/json', 'x-linkedstore-hmac-sha256': 'abc' }, payload: body });
    expect(forged.statusCode).toBe(401);
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    const ok = await app.inject({ method: 'POST', url: '/integrations/nuvemshop/webhook', headers: { 'content-type': 'application/json', 'x-linkedstore-hmac-sha256': sig }, payload: body });
    expect(ok.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const [store] = await db.db.select().from(nuvemshopStores);
    expect(store!.uninstalledAt).not.toBeNull();
  });

  it('com a chave publica configurada, o process_payment exige X-Signature valido', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signedConfig = testConfig({
      PUBLIC_BASE_URL: 'https://pay.example.com',
      NUVEMSHOP_APP_ID: '4242',
      NUVEMSHOP_CLIENT_ID: '4242',
      NUVEMSHOP_CLIENT_SECRET: SECRET,
      NUVEMSHOP_SIGNING_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const service = new NuvemshopService({ db: db.db, repos, config: signedConfig, logger: silentLogger, invoices, fetchImpl: api.fetchImpl as never });
    const body = '{"a":1}';
    const ts = String(Math.floor(Date.now() / 1000));
    const url = 'https://pay.example.com/integrations/nuvemshop/process';
    const signature = createSign('RSA-SHA256').update(`${url}|${ts}|${createHash('sha256').update(body).digest('hex')}`).sign(privateKey, 'base64');
    expect(service.verifyPlatformSignature({ url, timestamp: ts, signature, rawBody: body })).toBe(true);
    expect(service.verifyPlatformSignature({ url, timestamp: ts, signature, rawBody: '{"a":2}' })).toBe(false);
    expect(service.verifyPlatformSignature({ url, timestamp: String(Number(ts) - 900), signature, rawBody: body })).toBe(false);
  });

  it('script do checkout servido para o dominio da Nuvemshop', async () => {
    const res = await app.inject({ method: 'GET', url: '/integrations/nuvemshop/checkout.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.body).toContain("id: 'libreflow_redirect'");
  });
});
