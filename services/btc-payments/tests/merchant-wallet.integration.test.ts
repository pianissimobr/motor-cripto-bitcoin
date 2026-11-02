import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountXpub } from '../src/adapters/hd/derivation.js';
import type { LnbitsClient } from '../src/adapters/lnbits/client.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { paymentIntents } from '../src/db/schema.js';
import { ValidationError } from '../src/domain/errors.js';
import { silentLogger } from '../src/logger.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import { MerchantWalletService } from '../src/services/merchant-wallet-service.js';
import {
  createTestClient,
  testConfig,
  testTpub,
  truncateAll,
  type TestClient,
} from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

class FakeLnbits {
  private counter = 0;

  async createInvoice() {
    const paymentHash = `hash-wallet-${++this.counter}`;
    return {
      payment_hash: paymentHash,
      payment_request: `lnbc-wallet-${paymentHash}`,
    };
  }
}

maybeDescribe('merchant wallets (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let wallets: MerchantWalletService;
  let service: PaymentIntentService;
  let client: TestClient;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig();
    wallets = new MerchantWalletService(db.db);
    service = new PaymentIntentService({
      repos,
      lnbits: new FakeLnbits() as unknown as LnbitsClient,
      config,
      xpub: parseAccountXpub(config.btc.xpub, config.btc.network),
      logger: silentLogger,
    });
    client = await createTestClient(repos, config);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('cria carteira BTC por loja e atribui o endereco a intent', async () => {
    const wallet = await wallets.createBtcDeposit({
      merchantId: client.client.id,
      xpub: testTpub(),
      derivationPrefix: config.btc.derivationPrefix,
      network: config.btc.network,
      gapLimit: config.btc.gapLimit,
    });

    const created = await service.create({
      clientId: client.client.id,
      externalId: 'pedido-wallet-1',
      amountSats: 10_000n,
      walletId: wallet.id,
    });

    expect(created.dto.onchain?.address).toMatch(/^bcrt1/);

    const rows = await db.db
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, created.dto.id))
      .limit(1);
    expect(rows[0]?.merchantWalletId).toBe(wallet.id);
  });

  it('recusa carteira de outra loja', async () => {
    const other = await createTestClient(repos, config, {
      name: 'Outra loja',
    });
    const wallet = await wallets.createBtcDeposit({
      merchantId: other.client.id,
      xpub: testTpub(),
      derivationPrefix: config.btc.derivationPrefix,
      network: config.btc.network,
      gapLimit: config.btc.gapLimit,
    });

    await expect(
      service.create({
        clientId: client.client.id,
        externalId: 'pedido-wallet-2',
        amountSats: 10_000n,
        walletId: wallet.id,
      }),
    ).rejects.toThrow(ValidationError);
  });
});
