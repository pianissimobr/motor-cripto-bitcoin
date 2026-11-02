import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountXpub } from '../src/adapters/hd/derivation.js';
import type { LnbitsClient } from '../src/adapters/lnbits/client.js';
import type { AppConfig } from '../src/config.js';
import { signRequest } from '../src/crypto/hmac.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { merchantAccountCode, PLATFORM_ACCOUNTS } from '../src/domain/ledger.js';
import { buildApp } from '../src/http/app.js';
import { LedgerService } from '../src/ledger/ledger-service.js';
import { silentLogger } from '../src/logger.js';
import { ClientService } from '../src/services/client-service.js';
import { FixedFxPriceProvider, FxService } from '../src/services/fx-service.js';
import { MerchantWalletService } from '../src/services/merchant-wallet-service.js';
import { MetricsService } from '../src/services/metrics-service.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import { testConfig, testTpub, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;
const USDC_WALLET = '0x1111111111111111111111111111111111111111';

class FakeLnbits {
  private counter = 0;

  async createInvoice() {
    const paymentHash = `phase6-hash-${++this.counter}`;
    return {
      payment_hash: paymentHash,
      payment_request: `lnbc-phase6-${paymentHash}`,
    };
  }
}

maybeDescribe('phase 6 API (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let ledger: LedgerService;
  let wallets: MerchantWalletService;
  let paymentIntents: PaymentIntentService;
  let clients: ClientService;
  let fx: FxService;
  let metrics: MetricsService;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({
    });
    const xpub = parseAccountXpub(testTpub(), config.btc.network);
    await repos.initHdWalletState({
      gapLimit: config.btc.gapLimit,
      xpubFingerprint: xpub.fingerprint,
    });
    ledger = new LedgerService(db.db);
    wallets = new MerchantWalletService(db.db);
    paymentIntents = new PaymentIntentService({
      repos,
      lnbitsFor: () => new FakeLnbits() as unknown as LnbitsClient,
      config,
      logger: silentLogger,
    });
    clients = new ClientService({ repos, config, logger: silentLogger });
    fx = new FxService(
      db.db,
      new FixedFxPriceProvider({ BRL: 50_000_000n, USD: 1_000_000n }),
    );
    metrics = new MetricsService({ repos, ledger });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  function buildTestApp() {
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
        fx,
        ledger,
        metrics,
        wallets,
      },
    });
  }

  function signedHeaders(
    apiKey: string,
    requestSecret: string,
    method: string,
    path: string,
    body = '',
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

  async function createApiClient(
    app: ReturnType<typeof buildTestApp>,
    scopes?: string[],
  ) {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/clients',
      headers: { authorization: `Bearer ${config.server.adminToken}` },
      payload: {
        name: 'phase 6',
        webhook_url: 'http://localhost:9999/webhook',
        ...(scopes ? { scopes } : {}),
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      id: string;
      apiKey: string;
      requestSecret: string;
    };
  }

  async function get(
    app: ReturnType<typeof buildTestApp>,
    created: { apiKey: string; requestSecret: string },
    path: string,
  ) {
    return app.inject({
      method: 'GET',
      url: path,
      headers: signedHeaders(created.apiKey, created.requestSecret, 'GET', path),
    });
  }

  it('expõe carteiras, saldo, conversões, historico de payouts e taxas', async () => {
    const app = buildTestApp();
    const created = await createApiClient(app, [
      'payments:write',
      'payments:read',
      'wallets:read',
      'wallets:write',
      'balances:read',
      'conversions:read',
      'payouts:read',
    ]);
    const wallet = await app.inject({
      method: 'POST',
      url: '/v1/wallets',
      headers: signedHeaders(
        created.apiKey,
        created.requestSecret,
        'POST',
        '/v1/wallets',
        JSON.stringify({ kind: 'usdc_settlement', address: USDC_WALLET }),
      ),
      payload: { kind: 'usdc_settlement', address: USDC_WALLET },
    });
    expect(wallet.statusCode).toBe(201);
    expect(wallet.json().address).toBe(USDC_WALLET);

    const btcWallet = await app.inject({
      method: 'POST',
      url: '/v1/wallets',
      headers: signedHeaders(
        created.apiKey,
        created.requestSecret,
        'POST',
        '/v1/wallets',
        JSON.stringify({ kind: 'btc_deposit', xpub: testTpub() }),
      ),
      payload: { kind: 'btc_deposit', xpub: testTpub() },
    });
    expect(btcWallet.statusCode).toBe(201);

    const intentBody = JSON.stringify({
      external_id: 'phase6-intent',
      amount_sats: 100_000,
    });
    const intentResponse = await app.inject({
      method: 'POST',
      url: '/v1/payment-intents',
      headers: signedHeaders(
        created.apiKey,
        created.requestSecret,
        'POST',
        '/v1/payment-intents',
        intentBody,
      ),
      payload: { external_id: 'phase6-intent', amount_sats: 100_000 },
    });
    expect(intentResponse.statusCode).toBe(201);
    const intentId = intentResponse.json().id as string;
    await repos.markIntentPaid({
      intentId,
      status: 'pago',
      paidRail: 'onchain',
      paidAmountSats: 100_000n,
      overpaidSats: 0n,
      paidAt: new Date(),
    });

    const order = await repos.createConversionOrder({
      merchantId: created.id,
      intentId,
      sourceAmountSats: 100_000n,
      provider: 'thorchain',
      targetAmountMinor: 50_000_000n,
    });
    await repos.updateConversionOrder({
      id: order.id,
      status: 'convertida',
      targetAmountMinor: 50_000_000n,
    });
    await repos.updateIntentSettlement({
      intentId,
      from: ['nao_iniciado'],
      to: 'pago',
      conversionOrderId: order.id,
    });
    // Entrega direta: o ledger so registra o BTC; o USDC foi da THORChain
    // para a carteira do lojista sem passar pela plataforma.
    await ledger.postTransaction({
      kind: 'payment_received',
      referenceType: 'payment_intent',
      referenceId: intentId,
      entries: [
        { accountCode: PLATFORM_ACCOUNTS.treasuryBtc, asset: 'BTC', debitMinor: 100_000n },
        {
          accountCode: merchantAccountCode(created.id, 'btc_receivable'),
          merchantId: created.id,
          asset: 'BTC',
          creditMinor: 100_000n,
        },
      ],
    });

    const balances = await get(app, created, '/v1/balances');
    expect(balances.statusCode).toBe(200);
    expect(
      balances.json().balances.some(
        (item: { account_code: string; balance: string }) =>
          item.account_code === merchantAccountCode(created.id, 'btc_receivable') &&
          item.balance === '100000',
      ),
    ).toBe(true);

    const conversionsResponse = await get(app, created, '/v1/conversions');
    expect(conversionsResponse.statusCode).toBe(200);
    expect(conversionsResponse.json().data[0].id).toBe(order.id);

    const conversionResponse = await get(
      app,
      created,
      `/v1/conversions/${order.id}`,
    );
    expect(conversionResponse.statusCode).toBe(200);
    expect(conversionResponse.json().status).toBe('convertida');

    const payoutsResponse = await get(app, created, '/v1/payouts');
    expect(payoutsResponse.statusCode).toBe(200);
    expect(payoutsResponse.json().data).toHaveLength(0);

    const walletsResponse = await get(app, created, '/v1/wallets');
    expect(walletsResponse.statusCode).toBe(200);
    expect(walletsResponse.json().data).toHaveLength(2);

    const rates = await get(app, created, '/v1/fx/rates');
    expect(rates.statusCode).toBe(200);
    expect(rates.json().rates).toHaveLength(2);

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.body).toContain('btc_payments_ledger_balanced');

    const reconcile = await app.inject({
      method: 'GET',
      url: '/admin/api/reconciliation',
      headers: { authorization: `Bearer ${config.server.adminToken}` },
    });
    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.json().ok).toBe(true);

    const approve = await app.inject({
      method: 'POST',
      url: `/admin/api/payouts/${randomUUID()}/approve`,
      headers: { authorization: `Bearer ${config.server.adminToken}` },
      payload: {},
    });
    expect(approve.statusCode).toBe(404);

    await app.close();
  });

  it('bloqueia endpoint quando o escopo nao foi concedido', async () => {
    const app = buildTestApp();
    const created = await createApiClient(app, ['payments:read']);
    const response = await get(app, created, '/v1/balances');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('forbidden');
    await app.close();
  });
});

