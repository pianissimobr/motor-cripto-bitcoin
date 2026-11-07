import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountXpub } from '../src/adapters/hd/derivation.js';
import type { LnbitsClient } from '../src/adapters/lnbits/client.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { silentLogger } from '../src/logger.js';
import { buildApp } from '../src/http/app.js';
import { ClientService } from '../src/services/client-service.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import { AuthService } from '../src/services/auth-service.js';
import { NoopEmailSender } from '../src/services/email-sender.js';
import { MerchantWalletService } from '../src/services/merchant-wallet-service.js';
import { ReportService } from '../src/services/report-service.js';
import { SubscriptionService } from '../src/services/subscription-service.js';
import { FixedFxPriceProvider, FxService } from '../src/services/fx-service.js';
import { addBitcoinWallets, testConfig, testTpub, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

function cookieOf(
  setCookie: string | string[] | undefined,
  name: string,
): string | null {
  const entries =
    setCookie === undefined
      ? []
      : Array.isArray(setCookie)
        ? setCookie
        : [setCookie];
  for (const raw of entries) {
    const pair = raw.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name) {
      return pair.slice(eq + 1).trim();
    }
  }
  return null;
}

maybeDescribe('portal auth (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig();
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  function makeApp() {
    const xpub = parseAccountXpub(testTpub(), config.btc.network);
    const lnbits = {
      async createInvoice() {
        throw new Error('nao usado');
      },
      async getPayment() {
        throw new Error('nao usado');
      },
    } as unknown as LnbitsClient;
    const clients = new ClientService({ repos, config, logger: silentLogger });
    const auth = new AuthService({
      repos,
      clients,
      config,
      logger: silentLogger,
      emailSender: new NoopEmailSender(silentLogger),
    });
    const paymentIntents = new PaymentIntentService({
      repos,
      lnbitsFor: () => lnbits,
      config,
      logger: silentLogger,
    });
    const wallets = new MerchantWalletService(db.db);
    const reports = new ReportService({ db: db.db });
    const subscriptions = new SubscriptionService({
      repos,
      paymentIntents,
      logger: silentLogger,
    });

    return buildApp({
      config,
      logger: silentLogger,
      readiness: { checks: [] },
      services: {
        config,
        logger: silentLogger,
        repos,
        paymentIntents,
        clients,
        auth,
        wallets,
        reports,
        subscriptions,
        // R$ 500.000,00 e US$ 100.000,00 por BTC.
        fx: new FxService(
          db.db,
          new FixedFxPriceProvider({ BRL: 50_000_000n, USD: 10_000_000n }),
        ),
      },
    });
  }

  /** Cadastra e ja confirma o e-mail (o login so funciona confirmado). */
  async function register(app: ReturnType<typeof makeApp>, email: string, confirm = true) {
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'senha-forte-123', merchant_name: 'loja' },
    });
    if (confirm && reg.statusCode === 201) {
      await app.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { token: (reg.json() as { verification_token: string }).verification_token },
      });
    }
    return reg;
  }

  async function login(app: ReturnType<typeof makeApp>, email: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'senha-forte-123' },
    });
  }

  it('registra, verifica e faz login com sessao', async () => {
    const app = makeApp();
    const reg = await register(app, 'a@example.com', false);
    expect(reg.statusCode).toBe(201);
    const body = reg.json() as { verification_token: string; merchant: Record<string, unknown> };
    // O cadastro nao entrega nenhuma credencial.
    expect(Object.keys(body.merchant).sort()).toEqual(['id', 'name']);
    expect(body.verification_token).toBeTruthy();

    // Sem confirmar o e-mail, nao entra.
    const early = await login(app, 'a@example.com');
    expect(early.statusCode).toBe(403);
    expect(early.json().error.code).toBe('email_not_verified');

    const verify = await app.inject({
      method: 'POST',
      url: '/auth/verify-email',
      payload: { token: body.verification_token },
    });
    expect(verify.statusCode).toBe(200);

    const loginRes = await login(app, 'a@example.com');
    expect(loginRes.statusCode).toBe(200);
    const cookies = loginRes.headers['set-cookie'];
    const sid = cookieOf(cookies, 'portal_sid');
    expect(sid).toBeTruthy();

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `portal_sid=${sid}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as { merchants: Array<{ id: string }> };
    expect(meBody.merchants.length).toBe(1);

    // As credenciais so saem no portal, logado, uma vez por geracao.
    const csrf = cookieOf(cookies, 'portal_csrf')!;
    const merchantId = meBody.merchants[0]!.id;
    const gen = await app.inject({
      method: 'POST',
      url: `/v1/portal/merchants/${merchantId}/credentials`,
      headers: { cookie: `portal_sid=${sid}; portal_csrf=${csrf}`, 'x-csrf-token': csrf },
      payload: {},
    });
    expect(gen.statusCode).toBe(200);
    const creds = gen.json() as { api_key: string; request_secret: string; webhook_secret: string };
    expect(creds.api_key).toMatch(/^mk_btc_live_/);
    expect(creds.request_secret).toBeTruthy();
    expect(creds.webhook_secret).toBeTruthy();
    const client = await repos.findClientById(merchantId);
    expect(client?.apiKeyPrefix).toBe(creds.api_key.slice(0, 20));
  });

  it('checkout aceita valor em R$ e trava a cotacao em sats', async () => {
    const app = makeApp();
    const reg = await register(app, 'fx@example.com');
    const merchantId = (reg.json() as { merchant: { id: string } }).merchant.id;
    await addBitcoinWallets(db, config, merchantId, { lightning: false });
    const { sid, csrf } = await sessionFor(app, 'fx@example.com');
    const headers = { cookie: `portal_sid=${sid}; portal_csrf=${csrf}`, 'x-csrf-token': csrf };

    const rates = await app.inject({
      method: 'GET',
      url: '/v1/portal/fx/rates',
      headers: { cookie: `portal_sid=${sid}` },
    });
    expect(rates.statusCode).toBe(200);
    expect(rates.json().rates.map((r: { currency: string }) => r.currency).sort()).toEqual([
      'BRL',
      'USD',
    ]);

    const brl = await app.inject({
      method: 'POST',
      url: `/v1/portal/merchants/${merchantId}/checkout`,
      headers,
      payload: { amount: '5000', currency: 'BRL', description: 'R$ 50' },
    });
    expect(brl.statusCode).toBe(201);
    const intent = brl.json() as { amount_sats: string; amount_fiat: string; currency: string };
    // R$ 50,00 a R$ 500.000/BTC = 0,0001 BTC, sem margem.
    expect(intent.amount_sats).toBe('10000');
    expect(intent.amount_fiat).toBe('5000');
    expect(intent.currency).toBe('BRL');

    const both = await app.inject({
      method: 'POST',
      url: `/v1/portal/merchants/${merchantId}/checkout`,
      headers,
      payload: { amount: '5000', currency: 'BRL', amount_sats: '10' },
    });
    expect(both.statusCode).toBe(400);

    const market = await app.inject({
      method: 'GET',
      url: '/v1/portal/market',
      headers: { cookie: `portal_sid=${sid}` },
    });
    expect(market.statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/v1/portal/fx/rates' })).statusCode).toBe(401);
  });

  it('nao revela api key/request secret no perfil (so prefixo)', async () => {
    const app = makeApp();
    const reg = await register(app, 'b@example.com');
    expect(reg.statusCode).toBe(201);
    const merchantId = (reg.json() as { merchant: { id: string } }).merchant.id;
    const { sid, csrf } = await sessionFor(app, 'b@example.com');

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/portal/merchants/${merchantId}`,
      headers: { cookie: `portal_sid=${sid}` },
    });
    const detailBody = detail.json() as Record<string, unknown>;
    expect(detailBody.api_key_prefix).toBeTruthy();
    expect(detailBody).not.toHaveProperty('api_key');
    expect(detailBody).not.toHaveProperty('request_secret');
    expect(csrf).toBeTruthy();
  });

  it('em producao nao devolve token de reset nem de verificacao na resposta', async () => {
    const prod = testConfig({
      NODE_ENV: 'production',
      ADMIN_TOKEN: 'a'.repeat(32),
      METRICS_TOKEN: 'metrics-token-de-teste',
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    const auth = new AuthService({
      repos,
      clients: new ClientService({ repos, config: prod, logger: silentLogger }),
      config: prod,
      logger: silentLogger,
      emailSender: new NoopEmailSender(silentLogger),
    });
    const reg = await auth.register({ email: 'prod@example.com', password: 'senha-forte-123' });
    expect(reg.verificationToken).toBeUndefined();
    const forgot = await auth.forgotPassword('prod@example.com');
    expect(forgot).toEqual({ ok: true });
  });

  it('isola lojas entre usuarios (IDOR -> 403)', async () => {
    const app = makeApp();
    const regA = await register(app, 'a2@example.com');
    const merchantA = (regA.json() as { merchant: { id: string } }).merchant.id;
    await register(app, 'b2@example.com');
    const { sid } = await sessionFor(app, 'b2@example.com');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/portal/merchants/${merchantA}`,
      headers: { cookie: `portal_sid=${sid}` },
    });
    expect(res.statusCode).toBe(403);
  });

  async function sessionFor(app: ReturnType<typeof makeApp>, email: string) {
    const loginRes = await login(app, email);
    const cookies = loginRes.headers['set-cookie'];
    return {
      sid: cookieOf(cookies, 'portal_sid')!,
      csrf: cookieOf(cookies, 'portal_csrf')!,
    };
  }
});