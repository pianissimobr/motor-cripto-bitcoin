import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

maybeDescribe('hd index allocation (integration)', () => {
  let db: DbClient;
  let repos: Repositories;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await db.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL client_min_messages TO WARNING`);
      await tx.execute(
        sql`TRUNCATE hd_wallet_state, hd_addresses RESTART IDENTITY CASCADE`,
      );
    });
    await repos.initHdWalletState({ gapLimit: 20, xpubFingerprint: 'fp-teste' });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('aloca indices sequenciais', async () => {
    expect(await repos.allocateNextIndex(10)).toBe(0);
    expect(await repos.allocateNextIndex(10)).toBe(1);
    expect(await repos.allocateNextIndex(10)).toBe(2);
  });

  it('nao repete indices sob concorrencia', async () => {
    const indices = await Promise.all(
      Array.from({ length: 20 }, () => repos.allocateNextIndex(100)),
    );
    expect(new Set(indices).size).toBe(20);
    expect([...indices].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });

  it('para no limite de indices sem incrementar o estado', async () => {
    expect(await repos.allocateNextIndex(2)).toBe(0);
    expect(await repos.allocateNextIndex(2)).toBe(1);
    await expect(repos.allocateNextIndex(2)).rejects.toThrow(/limite/);
    const state = await repos.getHdWalletState();
    expect(state?.nextReceiveIndex).toBe(2);
  });

  it('persiste endereco unico e permite marcar como usado', async () => {
    const intentId = randomUUID();
    const address = await repos.insertHdAddress({
      index: 7,
      address: 'bcrt1qteste7',
      derivationPath: 'm/0/7',
      intentId,
    });
    expect(address.index).toBe(7);
    expect(address.status).toBe('alocada');

    const found = await repos.findHdAddressByIntentId(intentId);
    expect(found?.id).toBe(address.id);

    await repos.markHdAddressUsed(address.id);
    const state = await db.sql`select status, used_at from hd_addresses where id = ${address.id}`;
    expect(state[0]?.status).toBe('usada');
    expect(state[0]?.used_at).not.toBeNull();
  });

  it('rejeita indice ou endereco duplicado', async () => {
    await repos.insertHdAddress({
      index: 1,
      address: 'bcrt1qteste1',
      derivationPath: 'm/0/1',
    });
    await expect(
      repos.insertHdAddress({
        index: 1,
        address: 'bcrt1qteste2',
        derivationPath: 'm/0/2',
      }),
    ).rejects.toThrow();
  });
});
