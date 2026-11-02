import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { ledgerEntries } from '../src/db/schema.js';
import { merchantAccountCode, PLATFORM_ACCOUNTS } from '../src/domain/ledger.js';
import type { Alert } from '../src/services/alert-service.js';
import { LedgerService } from '../src/ledger/ledger-service.js';
import { silentLogger } from '../src/logger.js';
import { ReconciliationService } from '../src/services/reconciliation-service.js';
import {
  createTestClient,
  testConfig,
  truncateAll,
  type TestClient,
} from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

maybeDescribe('reconciliation (integration)', () => {
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

  async function postBalanced() {
    await ledger.postTransaction({
      kind: 'test',
      referenceType: 'test',
      referenceId: 'test-1',
      entries: [
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryUsdc,
          asset: 'USDC',
          debitMinor: 1_000n,
        },
        {
          accountCode: merchantAccountCode(client.client.id, 'usdc_available'),
          merchantId: client.client.id,
          asset: 'USDC',
          creditMinor: 1_000n,
        },
      ],
    });
  }

  it('passa quando o ledger esta balanceado', async () => {
    await postBalanced();
    const service = new ReconciliationService({
      repos,
      ledger,
      logger: silentLogger,
    });
    const result = await service.runCycle();
    expect(result.ok).toBe(true);
    expect(result.ledger[0]?.balanced).toBe(true);
    const runs = await repos.listReconciliationRuns(10);
    expect(runs[0]?.ok).toBe(true);
  });

  it('falha e alerta quando uma entry do ledger some', async () => {
    await postBalanced();
    const rows = await db.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.asset, 'USDC'))
      .limit(1);
    await db.db.execute(
      sql`delete from ledger_entries where id = ${rows[0]!.id}`,
    );
    const alerts: Alert[] = [];
    const service = new ReconciliationService({
      repos,
      ledger,
      logger: silentLogger,
      alerts: {
        send: async (alert: Alert) => {
          alerts.push(alert);
        },
      } as never,
    });
    const result = await service.runCycle();
    expect(result.ok).toBe(false);
    expect(alerts.some((alert) => alert.title === 'ledger desbalanceado')).toBe(
      true,
    );
    const runs = await repos.listReconciliationRuns(10);
    expect(runs[0]?.ok).toBe(false);
  });
});
