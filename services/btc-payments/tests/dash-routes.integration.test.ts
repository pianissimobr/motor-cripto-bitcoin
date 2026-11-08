import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createDashQueries } from '../src/db/dash-queries.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { silentLogger } from '../src/logger.js';
import { ClientService } from '../src/services/client-service.js';
import { DashAuthService } from '../src/services/dash-auth-service.js';
import { DashService } from '../src/services/dash-service.js';
import { sha256Hex } from '../src/crypto/hmac.js';
import { testConfig, truncateAll } from './helpers.js';
import { buildDashApp, MemoryEmailSender, signupAndLogin } from './dash-helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

const W1 = '0x4Cd01696Cd0165D6020AB7d8AE866Fdf2feD3855';
const W2 = '0x1111111111111111111111111111111111111111';
const STEP = { password: 'senha-forte-123' };

type Session = { cookie: string; csrf: string };

maybeDescribe('painel: API /v1/dash (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let mail: MemoryEmailSender;
  let app: FastifyInstance;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({ DASHBOARD_ENABLED: 'true', RATE_LIMIT_MAX: '1000' });
    mail = new MemoryEmailSender();
    const clients = new ClientService({ repos, config, logger: silentLogger });
    const auth = new DashAuthService({ repos, clients, config, logger: silentLogger, emailSender: mail });
    const dash = new DashService({
      config,
      logger: silentLogger,
      repos,
      queries: createDashQueries(db.db),
      clients,
      auth,
      emailSender: mail,
      usdcBalanceOf: async () => 1_234_567n,
    });
    app = buildDashApp({ config, repos, emailSender: mail, extra: { dashAuth: auth, dash } });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function login(email: string): Promise<Session & { merchantId: string }> {
    const session = await signupAndLogin(app, email);
    const res = await app.inject({ method: 'GET', url: '/v1/dash/merchants', headers: { cookie: session.cookie } });
    return { ...session, merchantId: res.json().merchants[0].id };
  }

  const get = (s: Session, url: string) => app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
  const send = (s: Session, method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown = {}) =>
    app.inject({ method, url, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, payload: payload as never });

  it('sem sessao: 401; loja de outro usuario: 404', async () => {
    const a = await login('a@ex.com');
    const b = await login('b@ex.com');
    expect((await app.inject({ method: 'GET', url: `/v1/dash/merchants/${a.merchantId}` })).statusCode).toBe(401);
    expect((await get(b, `/v1/dash/merchants/${a.merchantId}`)).statusCode).toBe(404);
    expect((await get(b, `/v1/dash/merchants/${a.merchantId}/wallets`)).statusCode).toBe(404);
    expect((await send(b, 'POST', `/v1/dash/merchants/${a.merchantId}/wallets`, { address: W1, step_up: STEP })).statusCode).toBe(404);
    expect((await get(a, `/v1/dash/merchants/${a.merchantId}`)).json().name).toBe('Loja a@ex.com');
  });

  it('escrita sem CSRF e recusada', async () => {
    const a = await login('c@ex.com');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/dash/merchants/${a.merchantId}`,
      headers: { cookie: a.cookie },
      payload: { name: 'Outro nome' },
    });
    expect(res.statusCode).toBe(403);
    const ok = await send(a, 'PATCH', `/v1/dash/merchants/${a.merchantId}`, { name: 'Outro nome' });
    expect(ok.json().name).toBe('Outro nome');
  });

  it('carteiras: senha obrigatoria, primeira vira padrao, troca e remocao', async () => {
    const a = await login('d@ex.com');
    const base = `/v1/dash/merchants/${a.merchantId}/wallets`;

    const wrong = await send(a, 'POST', base, { address: W1, step_up: { password: 'errada' } });
    expect(wrong.statusCode).toBe(401);
    const badChecksum = await send(a, 'POST', base, { address: W1.replace('Cd0', 'cD0'), step_up: STEP });
    expect(badChecksum.statusCode).toBe(400);

    const first = await send(a, 'POST', base, { address: W1, label: 'MetaMask', step_up: STEP });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ address: W1, label: 'MetaMask', is_default: true });
    const second = await send(a, 'POST', base, { address: W2, step_up: STEP });
    expect(second.json().is_default).toBe(false);

    // A padrao e o destino do Pix e do swap.
    expect((await repos.findActiveUsdcSettlementWalletForClient(a.merchantId))?.address).toBe(W1.toLowerCase());
    const switched = await send(a, 'POST', `${base}/${second.json().id}/default`, { step_up: STEP });
    expect(switched.json().wallets[0]).toMatchObject({ id: second.json().id, is_default: true });
    expect((await repos.findActiveUsdcSettlementWalletForClient(a.merchantId))?.address).toBe(W2);

    const removed = await send(a, 'POST', `${base}/${second.json().id}/remove`, { step_up: STEP });
    expect(removed.json().wallets).toEqual([expect.objectContaining({ id: first.json().id, is_default: true })]);

    const balance = await get(a, `${base}/${first.json().id}/balance`);
    expect(balance.json()).toMatchObject({ balance_minor: '1234567', decimals: 6 });
    expect(mail.sent.filter((m) => m.to === 'd@ex.com').length).toBeGreaterThanOrEqual(3);
  });

  it('o mesmo endereco nao vai para duas lojas', async () => {
    const a = await login('e@ex.com');
    const b = await login('f@ex.com');
    await send(a, 'POST', `/v1/dash/merchants/${a.merchantId}/wallets`, { address: W1, step_up: STEP });
    const dup = await send(b, 'POST', `/v1/dash/merchants/${b.merchantId}/wallets`, { address: W1, step_up: STEP });
    expect(dup.statusCode).toBe(409);
  });

  it('credenciais: saem uma vez e a chave antiga para de valer', async () => {
    const a = await login('g@ex.com');
    const url = `/v1/dash/merchants/${a.merchantId}/credentials`;
    const first = await send(a, 'POST', url, { step_up: STEP });
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    const key1 = first.json().api_key as string;
    expect(key1).toMatch(/^mk_btc_live_/);
    expect(first.json().request_secret).toBeTruthy();

    const view = await get(a, `/v1/dash/merchants/${a.merchantId}/integration`);
    expect(JSON.stringify(view.json())).not.toContain(key1);
    expect(view.json().api_key_prefix).toBe(key1.slice(0, 20));

    const second = await send(a, 'POST', url, { step_up: STEP });
    expect(await repos.findClientByApiKeyHash(sha256Hex(key1))).toBeNull();
    expect(await repos.findClientByApiKeyHash(sha256Hex(second.json().api_key))).not.toBeNull();
  });

  it('webhook: valida a URL, envia o teste e lista as entregas', async () => {
    const a = await login('h@ex.com');
    const base = `/v1/dash/merchants/${a.merchantId}/webhook`;
    expect((await send(a, 'POST', `${base}/test`)).statusCode).toBe(400);
    const internal = await send(a, 'PUT', base, { url: 'http://169.254.169.254/latest' });
    expect(internal.statusCode).toBe(400);
    const ok = await send(a, 'PUT', base, { url: 'https://example.com/ipn' });
    expect(ok.json().webhook_url).toBe('https://example.com/ipn');
    const test = await send(a, 'POST', `${base}/test`);
    expect(test.statusCode).toBe(202);
    const events = await get(a, `${base}/events`);
    expect(events.json().events).toEqual([expect.objectContaining({ event: 'ping', status: 'pendente' })]);

    const b = await login('i@ex.com');
    const replay = await send(b, 'POST', `/v1/dash/merchants/${b.merchantId}/webhook/events/${test.json().id}/replay`);
    expect(replay.statusCode).toBe(404);
  });

  it('pagamentos: lista da loja com filtro e cursor; visao geral', async () => {
    const a = await login('j@ex.com');
    const b = await login('k@ex.com');
    for (let i = 0; i < 5; i++) {
      const charge = await repos.createPixCharge({
        clientId: a.merchantId,
        externalId: `pedido-${i}`,
        providerExternalId: `pix_a_${i}`,
        amountBrlCents: 1000n * BigInt(i + 1),
      });
      if (i < 2) await repos.updatePixCharge({ id: charge.id, status: 'pago', paidAt: new Date() });
    }
    await repos.createPixCharge({ clientId: b.merchantId, externalId: 'de-outra-loja', providerExternalId: 'pix_b', amountBrlCents: 999n });

    const base = `/v1/dash/merchants/${a.merchantId}/payments?kind=pix&limit=2`;
    const p1 = (await get(a, base)).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = (await get(a, `${base}&cursor=${p1.next_cursor}`)).json();
    const p3 = (await get(a, `${base}&cursor=${p2.next_cursor}`)).json();
    const all = [...p1.items, ...p2.items, ...p3.items].map((i: { external_id: string }) => i.external_id);
    expect(new Set(all).size).toBe(5);
    expect(all).not.toContain('de-outra-loja');
    expect(p3.next_cursor).toBeNull();

    const paid = (await get(a, `/v1/dash/merchants/${a.merchantId}/payments?kind=pix&status=pago`)).json();
    expect(paid.items).toHaveLength(2);
    const search = (await get(a, `/v1/dash/merchants/${a.merchantId}/payments?kind=pix&external_id=dido-3`)).json();
    expect(search.items.map((i: { external_id: string }) => i.external_id)).toEqual(['pedido-3']);

    const overview = (await get(a, `/v1/dash/merchants/${a.merchantId}/overview?period=7d`)).json();
    expect(overview).toMatchObject({ payments_created: 5, payments_paid: 2, received_cents: '3000', conversion_rate: 40 });

    const detailOther = await get(b, `/v1/dash/merchants/${b.merchantId}/payments/pix/${p1.items[0].id}`);
    expect(detailOther.statusCode).toBe(404);
  });
});
