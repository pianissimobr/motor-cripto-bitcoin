import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { LuniumClient } from '../src/adapters/lunium/client.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { LedgerService } from '../src/ledger/ledger-service.js';
import { silentLogger } from '../src/logger.js';
import { PixChargeService } from '../src/services/pix-charge-service.js';
import { createTestClient, testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

/** Lunium falsa: conta as consultas por cobranca e serve o feed de eventos. */
function fakeLunium() {
  const state = {
    feed: [] as { ts: string; fluxo: string; ref: string; estado: string }[],
    feedFails: false,
    getCalls: [] as string[],
  };
  const lunium = {
    getEvents: async () => {
      if (state.feedFails) throw new Error('503');
      return { eventos: state.feed };
    },
    getCharge: async (id: string) => {
      state.getCalls.push(id);
      return { cashin_id: id, status: 'pending', settlement_status: 'pending', amount_cents: 2500, asset: 'USDC', chain: 'polygon' };
    },
    findChargesByExternalId: async () => [],
  };
  return { state, lunium };
}

maybeDescribe('reconcile PIX com o feed de eventos da Lunium (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({ PIX_ENABLED: 'true', LUNIUM_API_KEY: 'lun_test_key', LUNIUM_WEBHOOK_SECRET: 'whk_test_123' });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function openCharges(n: number) {
    const { client } = await createTestClient(repos, config);
    for (let i = 1; i <= n; i++) {
      const charge = await repos.createPixCharge({ clientId: client.id, externalId: `p${i}`, providerExternalId: `pix_${i}`, amountBrlCents: 2500n });
      // Ja consultada agora ha pouco: so volta na varredura.
      await repos.updatePixCharge({ id: charge.id, status: 'pendente', providerChargeId: `ci_${i}`, lastCheckedAt: new Date() });
    }
  }

  it('com o feed, so consulta o que mudou; sem o feed, consulta todas', async () => {
    await openCharges(5);
    const { state, lunium } = fakeLunium();
    const service = new PixChargeService({ repos, ledger: new LedgerService(db.db), lunium: lunium as unknown as LuniumClient, config, logger: silentLogger });

    state.feed = [
      { ts: '2026-11-08T10:00:01Z', fluxo: 'cashin', ref: 'ci_2', estado: 'paid' },
      { ts: '2026-11-08T10:00:02Z', fluxo: 'cashout', ref: 'co_9', estado: 'COMPLETED' },
    ];
    await service.reconcile(30);
    expect(state.getCalls).toEqual(['ci_2']);

    // O mesmo evento no proximo ciclo nao conta de novo.
    state.getCalls = [];
    await service.reconcile(30);
    expect(state.getCalls).toEqual([]);

    // Feed fora do ar: volta a consultar cada cobranca em aberto.
    state.feedFails = true;
    await service.reconcile(30);
    expect(state.getCalls.sort()).toEqual(['ci_1', 'ci_2', 'ci_3', 'ci_4', 'ci_5']);
  });

  it('a varredura ainda pega quem ficou tempo demais sem consulta', async () => {
    await openCharges(2);
    await db.db.execute(`update pix_charges set last_checked_at = now() - interval '10 minutes' where provider_charge_id = 'ci_1'` as never);
    const { state, lunium } = fakeLunium();
    const service = new PixChargeService({ repos, ledger: new LedgerService(db.db), lunium: lunium as unknown as LuniumClient, config, logger: silentLogger });
    await service.reconcile(30);
    expect(state.getCalls).toEqual(['ci_1']);
  });
});
