import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountXpub } from '../src/adapters/hd/derivation.js';
import type { EsploraClient } from '../src/adapters/chain/esplora.js';
import type { LnbitsClient } from '../src/adapters/lnbits/client.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { webhookEvents } from '../src/db/schema.js';
import type { PaymentIntent } from '../src/domain/types.js';
import { silentLogger } from '../src/logger.js';
import { OnchainWatcher } from '../src/services/onchain-watcher.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import {
  createTestClient,
  testConfig,
  truncateAll,
  type TestClient,
} from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

class FakeLnbits {
  private readonly invoices = new Map<
    string,
    { amountSats: bigint; paid: boolean }
  >();
  private counter = 0;

  async createInvoice(input: { amountSats: bigint }) {
    const paymentHash = `hash-${++this.counter}`;
    this.invoices.set(paymentHash, {
      amountSats: input.amountSats,
      paid: false,
    });
    return {
      payment_hash: paymentHash,
      payment_request: `lnbc-test-${paymentHash}`,
    };
  }

  async getPayment(paymentHash: string) {
    const invoice = this.invoices.get(paymentHash);
    if (!invoice) throw new Error(`invoice desconhecida: ${paymentHash}`);
    return {
      payment_hash: paymentHash,
      paid: invoice.paid,
      pending: !invoice.paid,
      status: invoice.paid ? 'paid' : 'pending',
      amount_sats: Number(invoice.amountSats),
    };
  }

  markPaid(paymentHash: string): void {
    const invoice = this.invoices.get(paymentHash);
    if (invoice) invoice.paid = true;
  }
}

class FakeEsplora {
  tip = 100;
  utxos = new Map<
    string,
    Array<{
      txid: string;
      vout: number;
      value: number;
      status: {
        confirmed: boolean;
        block_height?: number;
        block_hash?: string;
      };
    }>
  >();

  async getTipHeight(): Promise<number> {
    return this.tip;
  }

  async getAddressUtxos(address: string) {
    return this.utxos.get(address) ?? [];
  }
}

maybeDescribe('payment intent + onchain (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let lnbits: FakeLnbits;
  let service: PaymentIntentService;
  let client: TestClient;
  let now: Date;

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
    lnbits = new FakeLnbits();
    now = new Date('2026-01-01T00:00:00.000Z');
    service = new PaymentIntentService({
      repos,
      lnbits: lnbits as unknown as LnbitsClient,
      config,
      xpub,
      logger: silentLogger,
      now: () => now,
    });
    client = await createTestClient(repos, config);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function createIntent(externalId: string, amountSats = 1000n) {
    return service.create({
      clientId: client.client.id,
      externalId,
      amountSats,
      description: 'Teste',
    });
  }

  async function loadIntent(id: string): Promise<PaymentIntent | null> {
    return repos.findIntentByIdForClient(id, client.client.id);
  }

  async function eventsFor(intentId: string) {
    return db.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.intentId, intentId));
  }

  it('cria intent com Lightning + on-chain, QR e idempotencia', async () => {
    const dto = await createIntent('t1');
    expect(dto.status).toBe('pendente');
    expect(dto.lightning?.payment_hash).toBe('hash-1');
    expect(dto.onchain?.address).toMatch(/^bcrt1q/);
    expect(dto.onchain?.bip21).toContain('bitcoin:bcrt1q');
    expect(dto.payment_uri).toContain('lightning=lnbc-test-hash-1');
    expect(dto.qr_svg).toContain('<svg');

    const again = await createIntent('t1');
    expect(again.id).toBe(dto.id);

    await expect(createIntent('t1', 2000n)).rejects.toThrow(/outro valor/);
    const state = await repos.getHdWalletState();
    expect(state?.nextReceiveIndex).toBe(1);
  });

  it('confirma Lightning na fonte oficial e enfileira webhook', async () => {
    const dto = await createIntent('t2');
    const hash = dto.lightning!.payment_hash;
    lnbits.markPaid(hash);

    const result = await service.applyLightningPayment(hash);
    expect(result).toEqual({
      status: 'pago',
      valor: '1000',
      id_transacao: 't2',
    });

    const intent = await loadIntent(dto.id);
    expect(intent?.status).toBe('pago');
    expect(intent?.paidRail).toBe('lightning');
    expect(intent?.paidAmountSats).toBe(1000n);

    const events = await eventsFor(dto.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('payment_intent.paid');

    const repeat = await service.applyLightningPayment(hash);
    expect(repeat.status).toBe('ja_processado');
  });

  it('concilia invoice paga quando o webhook se perdeu', async () => {
    const dto = await createIntent('t3');
    lnbits.markPaid(dto.lightning!.payment_hash);
    const result = await service.reconcilePendingLightning(10);
    expect(result).toMatchObject({ checked: 1, paid: 1, errors: 0 });
    expect((await loadIntent(dto.id))?.status).toBe('pago');
  });

  it('expira intent sem pagamento e enfileira evento', async () => {
    const dto = await service.create({
      clientId: client.client.id,
      externalId: 't4',
      amountSats: 1000n,
      expiresInSeconds: 30,
    });
    now = new Date(now.getTime() + 31_000);
    const result = await service.expireDueIntents(10);
    expect(result.expired).toBe(1);
    expect((await loadIntent(dto.id))?.status).toBe('expirado');
    const events = await eventsFor(dto.id);
    expect(events[0]?.eventType).toBe('payment_intent.expired');
  });

  it('confirma on-chain e enfileira pagamento', async () => {
    const dto = await createIntent('t5');
    const address = dto.onchain!.address;
    const esplora = new FakeEsplora();
    esplora.utxos.set(address, [
      {
        txid: 'a'.repeat(64),
        vout: 0,
        value: 1000,
        status: {
          confirmed: true,
          block_height: 100,
          block_hash: 'b'.repeat(64),
        },
      },
    ]);
    const watcher = new OnchainWatcher({
      repos,
      esplora: esplora as unknown as EsploraClient,
      config,
      logger: silentLogger,
      now: () => now,
    });

    const result = await watcher.runCycle(10);
    expect(result).toMatchObject({ checked: 1, paid: 1, errors: 0 });

    const intent = await loadIntent(dto.id);
    expect(intent?.status).toBe('pago');
    expect(intent?.paidRail).toBe('onchain');
    expect(intent?.paidAmountSats).toBe(1000n);

    const events = await eventsFor(dto.id);
    expect(events[0]?.eventType).toBe('payment_intent.paid');
  });

  it('aceita pagamento on-chain depois de expirado (carência)', async () => {
    const dto = await createIntent('t6');
    await repos.markIntentExpired(dto.id);
    const esplora = new FakeEsplora();
    esplora.utxos.set(dto.onchain!.address, [
      {
        txid: 'c'.repeat(64),
        vout: 1,
        value: 1000,
        status: {
          confirmed: true,
          block_height: 100,
          block_hash: 'd'.repeat(64),
        },
      },
    ]);
    const watcher = new OnchainWatcher({
      repos,
      esplora: esplora as unknown as EsploraClient,
      config,
      logger: silentLogger,
      now: () => now,
    });

    const result = await watcher.runCycle(10);
    expect(result.late).toBe(1);
    const intent = await loadIntent(dto.id);
    expect(intent?.status).toBe('pago_tardio');
    const events = await eventsFor(dto.id);
    expect(events[0]?.eventType).toBe('payment_intent.paid_late');
  });

  it('detecta reorg e reabre o pagamento', async () => {
    const dto = await createIntent('t7');
    const esplora = new FakeEsplora();
    esplora.utxos.set(dto.onchain!.address, [
      {
        txid: 'e'.repeat(64),
        vout: 0,
        value: 1000,
        status: {
          confirmed: true,
          block_height: 100,
          block_hash: 'f'.repeat(64),
        },
      },
    ]);
    const watcher = new OnchainWatcher({
      repos,
      esplora: esplora as unknown as EsploraClient,
      config,
      logger: silentLogger,
      now: () => now,
    });
    expect((await watcher.runCycle(10)).paid).toBe(1);
    expect((await loadIntent(dto.id))?.status).toBe('pago');

    esplora.utxos.clear();
    const reorg = await watcher.runCycle(10);
    expect(reorg.reorged).toBe(1);
    expect((await loadIntent(dto.id))?.status).toBe('reorg');
    const events = await eventsFor(dto.id);
    expect(events.map((e) => e.eventType)).toContain(
      'payment_intent.reorged',
    );
  });


  it('marca parcial quando o on-chain fica abaixo do esperado na expiracao', async () => {
    const dto = await service.create({
      clientId: client.client.id,
      externalId: 't9',
      amountSats: 1000n,
      expiresInSeconds: 30,
    });
    await repos.upsertOnchainPayment({
      intentId: dto.id,
      addressId: (await loadIntent(dto.id))!.onchainAddressId!,
      txid: '9'.repeat(64),
      vout: 0,
      amountSats: 400n,
      blockHeight: 100,
      blockHash: '8'.repeat(64),
      confirmations: 1,
      status: 'confirmado',
    });
    now = new Date(now.getTime() + 31_000);
    const result = await service.expireDueIntents(10);
    expect(result.partial).toBe(1);
    expect((await loadIntent(dto.id))?.status).toBe('parcial');
    const events = await eventsFor(dto.id);
    expect(events[0]?.eventType).toBe('payment_intent.partial');
  });

  it('registra overpay quando o on-chain paga mais', async () => {
    const dto = await createIntent('t10');
    const esplora = new FakeEsplora();
    esplora.utxos.set(dto.onchain!.address, [
      {
        txid: '7'.repeat(64),
        vout: 0,
        value: 1500,
        status: {
          confirmed: true,
          block_height: 100,
          block_hash: '6'.repeat(64),
        },
      },
    ]);
    const watcher = new OnchainWatcher({
      repos,
      esplora: esplora as unknown as EsploraClient,
      config,
      logger: silentLogger,
      now: () => now,
    });
    const result = await watcher.runCycle(10);
    expect(result.paid).toBe(1);
    const intent = await loadIntent(dto.id);
    expect(intent?.status).toBe('pago');
    expect(intent?.paidAmountSats).toBe(1500n);
    expect(intent?.overpaidSats).toBe(500n);
  });

  it('detecta pagamento duplicado Lightning + on-chain', async () => {
    const dto = await createIntent('t11');
    const hash = dto.lightning!.payment_hash;
    lnbits.markPaid(hash);
    await service.applyLightningPayment(hash);

    const esplora = new FakeEsplora();
    esplora.utxos.set(dto.onchain!.address, [
      {
        txid: '5'.repeat(64),
        vout: 1,
        value: 1000,
        status: {
          confirmed: true,
          block_height: 100,
          block_hash: '4'.repeat(64),
        },
      },
    ]);
    const watcher = new OnchainWatcher({
      repos,
      esplora: esplora as unknown as EsploraClient,
      config,
      logger: silentLogger,
      now: () => now,
    });
    const result = await watcher.runCycle(10);
    expect(result.doublePaid).toBe(1);
    const intent = await loadIntent(dto.id);
    expect(intent?.status).toBe('pago');
    expect(intent?.paidRail).toBe('both');
    expect(intent?.paidAmountSats).toBe(2000n);
    expect(intent?.overpaidSats).toBe(1000n);
  });

  it('detecta reorg quando o UTXO confirmado volta para a mempool', async () => {
    const dto = await createIntent('t12');
    const address = dto.onchain!.address;
    const confirmedUtxo = {
      txid: '3'.repeat(64),
      vout: 0,
      value: 1000,
      status: {
        confirmed: true,
        block_height: 100,
        block_hash: '2'.repeat(64),
      },
    };
    const esplora = new FakeEsplora();
    esplora.utxos.set(address, [confirmedUtxo]);
    const watcher = new OnchainWatcher({
      repos,
      esplora: esplora as unknown as EsploraClient,
      config,
      logger: silentLogger,
      now: () => now,
    });
    expect((await watcher.runCycle(10)).paid).toBe(1);
    expect((await loadIntent(dto.id))?.status).toBe('pago');

    esplora.utxos.set(address, [
      { ...confirmedUtxo, status: { confirmed: false } },
    ]);
    const reorg = await watcher.runCycle(10);
    expect(reorg.reorged).toBe(1);
    expect((await loadIntent(dto.id))?.status).toBe('reorg');

    esplora.utxos.set(address, [confirmedUtxo]);
    const restored = await watcher.runCycle(10);
    expect(restored.paid).toBe(1);
    expect((await loadIntent(dto.id))?.status).toBe('pago');
  });
});
