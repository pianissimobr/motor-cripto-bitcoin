import { describe, expect, it } from 'vitest';
import type { Repositories } from '../src/db/repositories.js';
import type { ServiceFlag } from '../src/domain/types.js';
import { DEFAULT_APP_FLAGS, FlagsService } from '../src/services/flags-service.js';
import { silentLogger } from '../src/logger.js';

function fakeRepos(state: { rows: Map<string, ServiceFlag> }): Repositories {
  return {
    getServiceFlag: async (key: string) => state.rows.get(key) ?? null,
    setServiceFlag: async (key: string, value: Record<string, unknown>) => {
      const row: ServiceFlag = {
        key,
        value,
        updatedAt: new Date('2026-11-04T00:00:00Z'),
      };
      state.rows.set(key, row);
      return row;
    },
    insertAuditEvent: async () => undefined,
  } as unknown as Repositories;
}

describe('flags do app (F7)', () => {
  it('devolve o padrao quando nao ha nada gravado', async () => {
    const state = { rows: new Map<string, ServiceFlag>() };
    const result = await new FlagsService({
      repos: fakeRepos(state),
      logger: silentLogger,
    }).get();
    expect(result.flags).toEqual(DEFAULT_APP_FLAGS);
    expect(result.updated_at).toBeNull();
  });

  it('grava o rollback e devolve as flags', async () => {
    const state = { rows: new Map<string, ServiceFlag>() };
    const flags = new FlagsService({ repos: fakeRepos(state), logger: silentLogger });
    const saved = await flags.set({ cash_out_enabled: false });
    expect(saved.flags.cash_out_enabled).toBe(false);
    expect(saved.flags.cash_in_enabled).toBe(true);

    const read = await flags.get();
    expect(read.flags.cash_out_enabled).toBe(false);
  });

  it('ignora valor de tipo errado e usa o padrao', async () => {
    const state = { rows: new Map<string, ServiceFlag>() };
    state.rows.set('app_flags', {
      key: 'app_flags',
      value: { cash_out_enabled: 'nao', min_cash_out_brl: 12 },
      updatedAt: new Date(),
    });
    const result = await new FlagsService({
      repos: fakeRepos(state),
      logger: silentLogger,
    }).get();
    expect(result.flags.cash_out_enabled).toBe(true);
    expect(result.flags.min_cash_out_brl).toBe(12);
  });

  it('recusa faixa incoerente', async () => {
    const state = { rows: new Map<string, ServiceFlag>() };
    const flags = new FlagsService({ repos: fakeRepos(state), logger: silentLogger });
    await expect(
      flags.set({ min_cash_out_brl: 100, max_cash_out_brl: 10 }),
    ).rejects.toThrow(/max_cash_out_brl/);
  });
});
