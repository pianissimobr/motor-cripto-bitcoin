import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountXpub } from '../src/adapters/hd/derivation.js';
import type { LnbitsClient } from '../src/adapters/lnbits/client.js';
import type { AppConfig } from '../src/config.js';
import { signRequest } from '../src/crypto/hmac.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { buildApp } from '../src/http/app.js';
import { silentLogger } from '../src/logger.js';
import { ClientService } from '../src/services/client-service.js';
import { FixedFxPriceProvider, FxService } from '../src/services/fx-service.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import { testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

class FakeLnbits {
  async createInvoice() {
    return {
      payment_hash: `fx-${randomUUID()}`,
      payment_request: 'lnbc-fx-test',
    };
  }
}

maybeDescribe('API com cambio (integration)', () => {
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
    const xpub = parseAccountXpub(config.btc.xpub, config.btc.network);
    await repos.initHdWalletState({
      gapLimit: config.btc.gapLimit,
      xpubFingerprint: xpub.fingerprint,
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('cria intent por valor fiat e devolve cotacao', async () => {
    const xpub = parseAccountXpub(config.btc.xpub, config.btc.network);
    const paymentIntents = new PaymentIntentService({
      repos,
      lnbits: new FakeLnbits() as unknown as LnbitsClient,
      config,
      xpub,
      logger: silentLogger,
    });
    const fx = new FxService(
      db.db,
      new FixedFxPriceProvider({ BRL: 50_000_000n }),
    );
    const clients = new ClientService({ repos, config, logger: silentLogger });
    const app = buildApp({
      config,
      logger: silentLogger,
      readiness: { checks: [] },
      services: { config, logger: silentLogger, repos, paymentIntents, clients, fx },
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/admin/api/clients',
      headers: { authorization: `Bearer ${config.server.adminToken}` },
      payload: { name: 'loja fx', webhook_url: 'http://localhost:9999/webhook' },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json() as {
      apiKey: string;
      requestSecret: string;
    };

    const body = JSON.stringify({
      external_id: 'pedido-fx-1',
      amount: '100.00',
      currency: 'BRL',
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const signature = signRequest(created.requestSecret, {
      method: 'POST',
      path: '/v1/payment-intents',
      timestamp,
      nonce,
      body,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/payment-intents',
      headers: {
        authorization: `Bearer ${created.apiKey}`,
        'content-type': 'application/json',
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    const dto = response.json() as {
      amount_sats: string;
      currency: string;
      amount_fiat: string;
      settlement_status: string;
      fx_quote: { id: string; rate: string } | null;
    };
    expect(dto.amount_sats).toBe('20200');
    expect(dto.currency).toBe('BRL');
    expect(dto.amount_fiat).toBe('10000');
    expect(dto.settlement_status).toBe('nao_iniciado');
    expect(dto.fx_quote?.rate).toBe('202.000000000000000000');

    await app.close();
  });
});
