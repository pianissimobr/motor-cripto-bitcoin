import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { buildApp } from '../src/http/app.js';
import { silentLogger } from '../src/logger.js';
import { ClientService } from '../src/services/client-service.js';
import { InvoiceService } from '../src/services/invoice-service.js';
import { WebhookDeliveryService } from '../src/services/webhook-delivery-service.js';
import { createTestClient, testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

maybeDescribe('faturas hospedadas e chaves de loja (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let invoices: InvoiceService;
  let app: FastifyInstance;
  let now: Date;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({ RATE_LIMIT_MAX: '1000', PUBLIC_BASE_URL: 'https://pay.example.com' });
    now = new Date();
    invoices = new InvoiceService({
      db: db.db,
      repos,
      config,
      logger: silentLogger,
      lookupHost: async (host) => (host === 'interno.example.com' ? ['10.0.0.5'] : ['93.184.216.34']),
      now: () => now,
    });
    app = buildApp({
      config,
      logger: silentLogger,
      readiness: { checks: [] },
      services: {
        config,
        logger: silentLogger,
        repos,
        clients: new ClientService({ repos, config, logger: silentLogger }),
        invoices,
      } as never,
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function store(mode: 'live' | 'test', withWallet = true) {
    const { client } = await createTestClient(repos, config);
    if (withWallet) {
      await db.db.execute(
        `insert into merchant_wallets (merchant_id, kind, purpose, chain, network, address, status, is_default)
         values ('${client.id}', 'usdc_settlement', 'loja', 'polygon', 'polygon', '0x${client.id.replace(/-/g, '').slice(0, 32)}00000000', 'ativo', true)` as never,
      );
    }
    const created = await invoices.createStoreKey(client.id, mode, 'WooCommerce');
    return { client, apiKey: created.api_key, ipnSecret: created.ipn_secret, keyId: created.key.id };
  }

  const post = (key: string, url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: { 'x-api-key': key }, payload: payload as never });
  const get = (key: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-api-key': key } });

  const body = (extra: Record<string, unknown> = {}) => ({
    price_amount: '99.90',
    price_currency: 'brl',
    order_id: 1234,
    order_description: 'Pedido #1234',
    success_url: 'https://loja.example.com/obrigado',
    cancel_url: 'https://loja.example.com/carrinho',
    ipn_callback_url: 'https://loja.example.com/?wc-api=libreflow',
    ...extra,
  });

  it('x-api-key: sem chave, invalida ou revogada da 401; ping identifica a loja', async () => {
    const s = await store('test');
    expect((await app.inject({ method: 'GET', url: '/v1/ping' })).statusCode).toBe(401);
    expect((await get('mk_store_test_inexistente_aaaaaaaaaaaaaaa', '/v1/ping')).statusCode).toBe(401);
    const ping = await get(s.apiKey, '/v1/ping');
    expect(ping.json()).toMatchObject({ ok: true, mode: 'test' });
    await invoices.revokeStoreKey(s.client.id, s.keyId);
    expect((await get(s.apiKey, '/v1/ping')).statusCode).toBe(401);
  });

  it('cria a fatura e o mesmo order_id devolve a mesma', async () => {
    const s = await store('live');
    const first = await post(s.apiKey, '/v1/invoices', body());
    expect(first.statusCode).toBe(201);
    const dto = first.json();
    expect(dto).toMatchObject({ order_id: '1234', price_amount: '99.90', price_currency: 'BRL', status: 'aguardando', mode: 'live' });
    expect(dto.invoice_url).toBe(`https://pay.example.com/i/${dto.id}`);
    const again = await post(s.apiKey, '/v1/invoices', body({ price_amount: '1.00' }));
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(dto.id);
    expect((await get(s.apiKey, `/v1/invoices?order_id=1234`)).json().id).toBe(dto.id);
  });

  it('valida valor, URLs e rede interna no IPN; exige carteira em producao', async () => {
    const s = await store('live');
    expect((await post(s.apiKey, '/v1/invoices', body({ price_amount: '0' }))).statusCode).toBe(400);
    expect((await post(s.apiKey, '/v1/invoices', body({ order_id: 'a', success_url: 'javascript:alert(1)' }))).statusCode).toBe(400);
    expect((await post(s.apiKey, '/v1/invoices', body({ order_id: 'b', ipn_callback_url: 'https://interno.example.com/ipn' }))).statusCode).toBe(400);
    const noWallet = await store('live', false);
    const res = await post(noWallet.apiKey, '/v1/invoices', body());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/carteira/);
  });

  it('em dolar, sem Pix; sem Pix nem swap ligados, so USDC', async () => {
    const s = await store('live');
    const res = await post(s.apiKey, '/v1/invoices', body({ price_currency: 'USD' }));
    expect(res.json().rails).toEqual(['usdc']);
    const both = await post(s.apiKey, '/v1/invoices', body({ order_id: 'y', price_currency: 'USD', rails: ['pix', 'bitcoin'] }));
    expect(both.statusCode).toBe(400);
    const btc = await post(s.apiKey, '/v1/invoices', body({ order_id: 'z', price_currency: 'USD', rails: ['bitcoin', 'usdc'] }));
    expect(btc.json().rails).toEqual(['bitcoin', 'usdc']);
    expect((await post(s.apiKey, '/v1/invoices', body({ order_id: 'x', price_currency: 'USD', rails: ['pix'] }))).statusCode).toBe(400);
  });

  it('modo teste: escolhe Pix, simula, dispara o IPN assinado com o segredo da chave', async () => {
    const s = await store('test');
    const created = (await post(s.apiKey, '/v1/invoices', body())).json();

    const page = await app.inject({ method: 'GET', url: `/i/${created.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('MODO TESTE');
    expect(page.body).not.toContain('<script>');

    const badTax = await app.inject({ method: 'POST', url: `/i/${created.id}/pix`, payload: { payer_tax_number: '123.456.789-00' } });
    expect(badTax.statusCode).toBe(400);
    const pix = await app.inject({ method: 'POST', url: `/i/${created.id}/pix`, payload: { payer_tax_number: '000.000.001-91' } });
    expect(pix.json()).toMatchObject({ rail: 'pix', test: true });

    const sim = await app.inject({ method: 'POST', url: `/i/${created.id}/simulate`, payload: {} });
    expect(sim.json().status).toBe('pago');
    const state = (await app.inject({ method: 'GET', url: `/i/${created.id}/state` })).json();
    expect(state).toMatchObject({ status: 'pago', success_url: 'https://loja.example.com/obrigado' });

    // A chave de producao da mesma loja nao enxerga a fatura de teste.
    expect((await get(s.apiKey, `/v1/invoices/${created.id}`)).json()).toMatchObject({ status: 'pago', paid_rail: 'pix' });

    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const delivery = new WebhookDeliveryService({
      repos,
      config,
      logger: silentLogger,
      now: () => new Date(Date.now() + 5_000),
      fetchImpl: (async (url: string, init: RequestInit) => {
        sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
        return new Response('ok', { status: 200 });
      }) as never,
    });
    await delivery.runCycle(10);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://loja.example.com/?wc-api=libreflow');
    expect(sent[0]!.headers['x-webhook-event']).toBe('invoice.pago');
    const [t, v1] = sent[0]!.headers['x-webhook-signature']!.split(',').map((p) => p.split('=')[1]);
    const expected = createHmac('sha256', s.ipnSecret).update(`${t}.${sent[0]!.body}`).digest('hex');
    expect(v1).toBe(expected);
    expect(JSON.parse(sent[0]!.body).data).toMatchObject({ id: created.id, order_id: '1234', status: 'pago' });

    // Simular de novo nao paga duas vezes.
    expect((await app.inject({ method: 'POST', url: `/i/${created.id}/simulate`, payload: {} })).statusCode).toBe(409);
  });

  it('producao: simular nao existe; chave de teste nao le fatura de producao', async () => {
    const live = await store('live');
    const created = (await post(live.apiKey, '/v1/invoices', body({ rails: ['pix', 'usdc'] }))).json();
    expect((await app.inject({ method: 'POST', url: `/i/${created.id}/simulate`, payload: {} })).statusCode).toBe(404);
    const testKey = await invoices.createStoreKey(live.client.id, 'test');
    expect((await get(testKey.api_key, `/v1/invoices/${created.id}`)).statusCode).toBe(404);
    // Sem o servico de Pix configurado, a escolha falha com mensagem clara.
    const pix = await app.inject({ method: 'POST', url: `/i/${created.id}/pix`, payload: { payer_tax_number: '00000000191' } });
    expect(pix.json().error.message).toMatch(/Pix indisponivel/);
  });

  it('o job expira a fatura vencida e avisa uma vez', async () => {
    const s = await store('test');
    const created = (await post(s.apiKey, '/v1/invoices', body({ expires_in_minutes: 15 }))).json();
    now = new Date(now.getTime() + 16 * 60_000);
    const first = await invoices.runSyncCycle(10);
    expect(first.changed).toBe(1);
    await invoices.runSyncCycle(10);
    const state = (await app.inject({ method: 'GET', url: `/i/${created.id}/state` })).json();
    expect(state).toMatchObject({ status: 'expirado', cancel_url: 'https://loja.example.com/carrinho', payments: [] });
    const events = await repos.listWebhookEvents(10);
    expect(events.map((e) => e.eventType)).toEqual(['invoice.expirado']);
    expect((await app.inject({ method: 'POST', url: `/i/${created.id}/pix`, payload: { payer_tax_number: '00000000191' } })).statusCode).toBe(409);
  });
});
