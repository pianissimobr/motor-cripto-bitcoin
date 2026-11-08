import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;
const DESTINATION = '0xe49fbc85d36b37ea85895c339aa9044b0d2b7ce6';
const TX = `0x${'ab'.repeat(32)}`;

/**
 * A reserva da transferencia que provou a entrega do swap: o indice unico do
 * Postgres e o que garante "uma transferencia, um pedido" mesmo com dois
 * workers conferindo ao mesmo tempo.
 */
maybeDescribe('prova de entrega do swap (integration)', () => {
  let db: DbClient;
  let repos: Repositories;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function newOrder(clientId: string, externalId: string): Promise<string> {
    const created = await repos.createSwapOrder({
      clientId,
      externalId,
      amountFiatCents: 10_000n,
      currency: 'BRL',
      amountSats: 200_000n + BigInt(externalId.length),
      sellAsset: 'BTC.BTC',
      buyAsset: 'POL.USDC',
      destinationAddress: DESTINATION,
    });
    return created.id;
  }

  it('a mesma transferencia nao prova dois pedidos (nem em paralelo)', async () => {
    const client = await repos.createClient({
      id: randomUUID(),
      name: 'swap',
      apiKeyPrefix: 'mk_test',
      apiKeyHash: `hash-${randomUUID()}`,
      requestSecretEnc: 'secret',
      webhookUrl: '',
      webhookSecretEnc: 'secret',
    });
    const a = await newOrder(client.id, 'a');
    const b = await newOrder(client.id, 'bb');

    expect(await repos.isSwapDeliveryClaimed(TX, 4)).toBe(false);
    const results = await Promise.all([
      repos.claimSwapDelivery(a, TX.toUpperCase().replace('0X', '0x'), 4),
      repos.claimSwapDelivery(b, TX, 4),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repos.isSwapDeliveryClaimed(TX, 4)).toBe(true);

    // Outro log da mesma transacao e outra transferencia.
    const loser = results[0] ? b : a;
    expect(await repos.claimSwapDelivery(loser, TX, 5)).toBe(true);
    // Um pedido ja provado nao troca de prova.
    expect(await repos.claimSwapDelivery(loser, `0x${'cd'.repeat(32)}`, 0)).toBe(false);

    await repos.updateSwapOrder({ id: a, startBlock: 123n });
    expect((await repos.findSwapOrderById(a))?.startBlock).toBe(123n);
  });
});
