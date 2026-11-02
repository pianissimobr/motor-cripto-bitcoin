import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbClient } from '../src/db/client.js';
import type { Repositories } from '../src/db/repositories.js';
import { createRepositories } from '../src/db/repositories.js';
import {
  merchantAccountCode,
  PLATFORM_ACCOUNTS,
} from '../src/domain/ledger.js';
import { LedgerService } from '../src/ledger/ledger-service.js';
import {
  createTestClient,
  testConfig,
  truncateAll,
  type TestClient,
} from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

maybeDescribe('ledger (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let ledger: LedgerService;
  let client: TestClient;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    ledger = new LedgerService(db.db);
    client = await createTestClient(repos, testConfig());
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('grava transacao balanceada e deriva o saldo por conta', async () => {
    const merchantId = client.client.id;
    const transaction = await ledger.postTransaction({
      kind: 'payment_received',
      referenceType: 'payment_intent',
      referenceId: 'intent-1',
      entries: [
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryBtc,
          asset: 'BTC',
          debitMinor: 100_000n,
        },
        {
          accountCode: merchantAccountCode(merchantId, 'btc_receivable'),
          merchantId,
          asset: 'BTC',
          creditMinor: 100_000n,
        },
      ],
    });

    expect(transaction.id).toBeTruthy();

    const treasury = await ledger.getAccountTotals(
      PLATFORM_ACCOUNTS.treasuryBtc,
      'BTC',
    );
    const merchant = await ledger.getAccountTotals(
      merchantAccountCode(merchantId, 'btc_receivable'),
      'BTC',
    );

    expect(treasury.debit).toBe(100_000n);
    expect(treasury.credit).toBe(0n);
    expect(treasury.balance).toBe(100_000n);
    expect(merchant.debit).toBe(0n);
    expect(merchant.credit).toBe(100_000n);
    expect(merchant.balance).toBe(-100_000n);
  });

  it('reutiliza a mesma conta em transacoes diferentes', async () => {
    const merchantId = client.client.id;
    for (let i = 0; i < 2; i++) {
      await ledger.postTransaction({
        kind: 'payment_received',
        referenceType: 'payment_intent',
        referenceId: `intent-${i}`,
        entries: [
          {
            accountCode: PLATFORM_ACCOUNTS.treasuryUsdc,
            asset: 'USDC',
            debitMinor: 1_000n,
          },
          {
            accountCode: merchantAccountCode(merchantId, 'usdc_available'),
            merchantId,
            asset: 'USDC',
            creditMinor: 1_000n,
          },
        ],
      });
    }

    const totals = await ledger.getAccountTotals(
      merchantAccountCode(merchantId, 'usdc_available'),
      'USDC',
    );
    expect(totals.credit).toBe(2_000n);
  });

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    ledger = new LedgerService(db.db);
    client = await createTestClient(repos, testConfig());
  });
});
