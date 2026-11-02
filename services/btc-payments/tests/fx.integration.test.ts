import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbClient } from '../src/db/client.js';
import type { Repositories } from '../src/db/repositories.js';
import { createRepositories } from '../src/db/repositories.js';
import { FixedFxPriceProvider, FxService } from '../src/services/fx-service.js';
import {
  createTestClient,
  testConfig,
  truncateAll,
  type TestClient,
} from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

maybeDescribe('fx quotes (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let fx: FxService;
  let client: TestClient;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    client = await createTestClient(repos, testConfig());
    fx = new FxService(
      db.db,
      new FixedFxPriceProvider({ BRL: 50_000_000n, USD: 1_000_000n }),
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('cria e persiste quote BRL com spread', async () => {
    const quote = await fx.createQuote({
      merchantId: client.client.id,
      amountFiatCents: 10_000n,
      currency: 'BRL',
      spreadBps: 100,
      ttlSeconds: 600,
    });

    expect(quote.amountIn).toBe(10_000n);
    expect(quote.amountOut).toBe(20_200n);
    expect(quote.rate).toBe('202.000000000000000000');
    expect(quote.expiresAt.toISOString()).toBe('2026-01-01T00:10:00.000Z');

    const found = await fx.getQuote(quote.id);
    expect(found?.id).toBe(quote.id);
  });
});
