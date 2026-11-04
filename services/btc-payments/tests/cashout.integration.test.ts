import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LuniumClient, type LuniumCashOut } from '../src/adapters/lunium/client.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { silentLogger } from '../src/logger.js';
import { CashOutService } from '../src/services/cashout-service.js';
import { testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;
const ORIGIN = '0xe49FBc85D36B37Ea85895c339aA9044b0D2B7ce6';

class FakeLunium {
  counter = 0;
  createCalls = 0;
  acceptCalls = 0;
  failCreate = false;
  order: LuniumCashOut = {
    cashout_id: 'co_test_1',
    state: 'QUOTE_CREATED',
    asset: 'USDC',
    network: 'polygon',
    amount: '1.436256',
    brl_amount: '6.50',
    external_id: 'cashout_1',
    path: 'DEX',
  };

  async previewCashOut() {
    return { ...this.order, state: 'QUOTE_CREATED' };
  }

  async createCashOut() {
    this.createCalls++;
    if (this.failCreate) {
      throw new Error('timeout simulado');
    }
    this.counter++;
    this.order = { ...this.order, cashout_id: `co_test_${this.counter}` };
    return this.order;
  }

  async acceptCashOut() {
    this.acceptCalls++;
    this.order = {
      ...this.order,
      state: 'AWAITING_DEPOSIT',
      deposit_address: '0x59B40519ac007AFffA8571d2966DdbCd8b59E585',
      deposit_tag: null,
    };
    return this.order;
  }

  async getCashOut() {
    return this.order;
  }

  async findCashOutsByExternalId() {
    return [this.order];
  }

  async setCashOutRefundAddress() {
    return this.order;
  }
}

maybeDescribe('cash-out: cripto -> Pix (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let cashOut: CashOutService;
  let fake: FakeLunium;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({
      PIX_ENABLED: 'true',
      CASHOUT_ENABLED: 'true',
      LUNIUM_API_KEY: 'lun_test_key',
    });
    fake = new FakeLunium();
    cashOut = new CashOutService({
      repos,
      lunium: fake as unknown as LuniumClient,
      config,
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function createClient(name: string): Promise<string> {
    const client = await repos.createClient({
      id: crypto.randomUUID(),
      name,
      apiKeyPrefix: 'mk_test',
      apiKeyHash: `hash-${crypto.randomUUID()}`,
      requestSecretEnc: 'secret',
      webhookUrl: 'http://localhost:9999/webhook',
      webhookSecretEnc: 'secret',
    });
    return client.id;
  }

  it('cria a ordem e devolve o endereco de deposito no aceite', async () => {
    const clientId = await createClient('app cash-out');
    const { dto, reused } = await cashOut.create({
      clientId,
      externalId: 'app-1',
      amountBrlCents: 650n,
      originAddress: ORIGIN,
      pixKey: 'adm@pianolabribeirao.com.br',
      pixKeyType: 'email',
    });
    expect(reused).toBe(false);
    expect(dto.status).toBe('pendente');
    expect(dto.provider_cashout_id).toBe('co_test_1');
    expect(dto.origin_address).toBe(ORIGIN.toLowerCase());
    // A chave Pix fica mascarada no motor.
    expect(dto.pix_key).toBe('a•@pianolabribeirao.com.br');

    const accepted = await cashOut.accept(dto.id, clientId);
    expect(accepted.status).toBe('aguardando_deposito');
    expect(accepted.deposit_address).toBe('0x59B40519ac007AFffA8571d2966DdbCd8b59E585');
    expect(accepted.deposit_tag).toBeNull();
  });

  it('e idempotente por external_id', async () => {
    const clientId = await createClient('app cash-out');
    const first = await cashOut.create({
      clientId,
      externalId: 'app-1',
      amountBrlCents: 650n,
      originAddress: ORIGIN,
      pixKey: 'adm@pianolabribeirao.com.br',
    });
    const second = await cashOut.create({
      clientId,
      externalId: 'app-1',
      amountBrlCents: 650n,
      originAddress: ORIGIN,
      pixKey: 'adm@pianolabribeirao.com.br',
    });
    expect(second.reused).toBe(true);
    expect(second.dto.id).toBe(first.dto.id);
    // A Lunium nao foi chamada de novo.
    expect(fake.createCalls).toBe(1);
  });

  it('recusa o mesmo external_id com outro valor', async () => {
    const clientId = await createClient('app cash-out');
    await cashOut.create({
      clientId,
      externalId: 'app-1',
      amountBrlCents: 650n,
      originAddress: ORIGIN,
      pixKey: 'adm@pianolabribeirao.com.br',
    });
    await expect(
      cashOut.create({
        clientId,
        externalId: 'app-1',
        amountBrlCents: 700n,
        originAddress: ORIGIN,
        pixKey: 'adm@pianolabribeirao.com.br',
      }),
    ).rejects.toThrow(/external_id ja usado/);
  });

  it('registra o tx_hash que o app assinou', async () => {
    const clientId = await createClient('app cash-out');
    const { dto } = await cashOut.create({
      clientId,
      externalId: 'app-1',
      amountBrlCents: 650n,
      originAddress: ORIGIN,
      pixKey: 'adm@pianolabribeirao.com.br',
    });
    const txHash = `0x${'a'.repeat(64)}`;
    const reported = await cashOut.reportDeposit(dto.id, clientId, txHash);
    expect(reported.tx_hash).toBe(txHash);
    await expect(
      cashOut.reportDeposit(dto.id, clientId, '0x123'),
    ).rejects.toThrow(/tx_hash invalido/);
  });

  it('nao deixa um cliente ler o cash-out de outro', async () => {
    const clientId = await createClient('dono');
    const outro = await createClient('outro');
    const { dto } = await cashOut.create({
      clientId,
      externalId: 'app-1',
      amountBrlCents: 650n,
      originAddress: ORIGIN,
      pixKey: 'adm@pianolabribeirao.com.br',
    });
    await expect(cashOut.sync(dto.id, outro)).rejects.toThrow(/nao encontrado/);
  });

  it('reconcilia a ordem quando o app ficou fechado', async () => {
    const clientId = await createClient('app cash-out');
    const { dto } = await cashOut.create({
      clientId,
      externalId: 'app-1',
      amountBrlCents: 650n,
      originAddress: ORIGIN,
      pixKey: 'adm@pianolabribeirao.com.br',
    });
    fake.order = {
      ...fake.order,
      state: 'COMPLETED',
      pix_e2e: 'E3729393020261104024702905451d07',
      receipt_url: 'https://app.luniumpay.com/comprovante/abc',
    };
    const result = await cashOut.reconcile(10);
    expect(result.synced).toBeGreaterThan(0);
    const synced = await cashOut.sync(dto.id, clientId);
    expect(synced.status).toBe('liquidado');
    expect(synced.pix_e2e).toBe('E3729393020261104024702905451d07');
  });
});
