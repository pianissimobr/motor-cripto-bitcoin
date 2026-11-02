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
import { testConfig, truncateAll } from './helpers.js';

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
    const xpub = parseAccountXpub(config.btc.xpub, config.btc.network);
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
      lnbits,
      config,
      xpub,
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
      },
    });
  }

  async function register(app: ReturnType<typeof makeApp>, email: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'senha-forte-123', merchant_name: 'loja' },
    });
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
    const reg = await register(app, 'a@example.com');
    expect(reg.statusCode).toBe(201);
    const body = reg.json() as { verification_token: string; merchant: { api_key: string } };
    expect(body.merchant.api_key).toMatch(/^mk_btc_live_/);
    expect(body.verification_token).toBeTruthy();

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