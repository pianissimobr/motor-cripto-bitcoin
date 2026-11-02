import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountXpub } from '../src/adapters/hd/derivation.js';
import type { EsploraClient, EsploraTx } from '../src/adapters/chain/esplora.js';
import { UpstreamError } from '../src/domain/errors.js';
import type { LnbitsClient } from '../src/adapters/lnbits/client.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { paymentIntents, webhookEvents } from '../src/db/schema.js';
import type { PaymentIntent } from '../src/domain/types.js';
import { silentLogger } from '../src/logger.js';
import { OnchainWatcher } from '../src/services/onchain-watcher.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import {
  addBitcoinWallets,
  createTestClient,
  testConfig,
  testTpub,
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
  omitAmount = false;
  amountMsat: number | undefined;
  amountSats: number | undefined;

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
    const base = {
      payment_hash: paymentHash,
      paid: invoice.paid,
      pending: !invoice.paid,
      status: invoice.paid ? 'paid' : 'pending',
    };
    if (this.omitAmount) return base;
    return {
      ...base,
      ...(this.amountMsat !== undefined ? { amount_msat: this.amountMsat } : {}),
      amount_sats:
        this.amountSats !== undefined
          ? this.amountSats
          : Number(invoice.amountSats),
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

  txs = new Set<string>();
  /** Altura do bloco de cada tx; sem registro, a tx esta no bloco do tip. */
  txHeights = new Map<string, number>();

  async getTipHeight(): Promise<number> {
    return this.tip;
  }

  async getAddressUtxos(address: string) {
    return this.utxos.get(address) ?? [];
  }

  async getTx(txid: string): Promise<EsploraTx> {
    if (!this.txs.has(txid)) {
      throw new UpstreamError('Esplora respondeu HTTP 404');
    }
    return {
      txid,
      status: {
        confirmed: true,
        block_height: this.txHeights.get(txid) ?? this.tip,
        block_hash: 'b'.repeat(64),
      },
      vin: [],
      vout: [],
    };
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
    const xpub = parseAccountXpub(testTpub(), config.btc.network);
    await repos.initHdWalletState({
      gapLimit: config.btc.gapLimit,
      xpubFingerprint: xpub.fingerprint,
    });
    lnbits = new FakeLnbits();
    now = new Date('2026-01-01T00:00:00.000Z');
    service = new PaymentIntentService({
      repos,
      lnbitsFor: () => lnbits as unknown as LnbitsClient,
      config,
      logger: silentLogger,
      now: () => now,
    });
    client = await createTestClient(repos, config);
    await addBitcoinWallets(db, config, client.client.id);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function createIntent(externalId: string, amountSats = 1000n) {
    const created = await service.create({
      clientId: client.client.id,
      externalId,
      amountSats,
      description: 'Teste',
    });
    return created.dto;
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
    // O indice e da carteira (xpub) do lojista, nao da plataforma.
    const intent = await loadIntent(dto.id);
    const wallet = await repos.findActiveBtcDepositWalletForClient(client.client.id);
    expect(intent?.merchantWalletId).toBe(wallet?.id);
    expect(intent?.lightningWalletId).toBeTruthy();
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
    const dto = (
      await service.create({
        clientId: client.client.id,
        externalId: 't4',
        amountSats: 1000n,
        expiresInSeconds: 30,
      })
    ).dto;
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
    const dto = (
      await service.create({
        clientId: client.client.id,
        externalId: 't9',
        amountSats: 1000n,
        expiresInSeconds: 30,
      })
    ).dto;
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
    const events = await eventsFor(dto.id);
    expect(events.filter((event) => event.eventType === 'payment_intent.paid')).toHaveLength(2);
  });

  it('nao reorga quando o UTXO foi gasto (sweep legado)', async () => {
    const dto = await createIntent('t13');
    const funding = 'a1'.repeat(32);
    const sweepTx = 'b1'.repeat(32);
    const esplora = new FakeEsplora();
    esplora.utxos.set(dto.onchain!.address, [
      {
        txid: funding,
        vout: 0,
        value: 1000,
        status: { confirmed: true, block_height: 100, block_hash: 'c1'.repeat(32) },
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
    const intent = await loadIntent(dto.id);
    const claimed = await repos.claimSweep({
      intentId: intent!.id,
      addressId: intent!.onchainAddressId!,
      amountSats: 900n,
      feeSats: 100n,
      coldWalletAddress: 'bcrt1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      inputs: [{ txid: funding, vout: 0, amountSats: '1000' }],
    });
    await repos.updateSweep({
      id: claimed!.id,
      status: 'aguardando_confirmacao_rede',
      txid: sweepTx,
    });
    esplora.txs.add(sweepTx);
    esplora.txs.add(funding);
    esplora.utxos.clear();
    const cycle = await watcher.runCycle(10);
    expect(cycle.reorged).toBe(0);
    expect((await loadIntent(dto.id))?.status).toBe('pago');
    const payments = await repos.listOnchainPaymentsForIntent(dto.id);
    expect(payments[0]?.status).toBe('gasto');
  });

  it('nao reorga quando o lojista gasta o BTC da propria carteira', async () => {
    const dto = await createIntent('t13b');
    const funding = 'a2'.repeat(32);
    const esplora = new FakeEsplora();
    esplora.utxos.set(dto.onchain!.address, [
      {
        txid: funding,
        vout: 0,
        value: 1000,
        status: { confirmed: true, block_height: 100, block_hash: 'c2'.repeat(32) },
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

    // O endereco e do lojista: ele move o BTC (sem nenhum sweep da plataforma).
    esplora.txs.add(funding);
    esplora.utxos.clear();
    const cycle = await watcher.runCycle(10);
    expect(cycle.reorged).toBe(0);
    expect((await loadIntent(dto.id))?.status).toBe('pago');
    const payments = await repos.listOnchainPaymentsForIntent(dto.id);
    expect(payments[0]?.status).toBe('gasto');
    expect((await eventsFor(dto.id)).some((e) => e.eventType === 'payment_intent.reorged')).toBe(
      false,
    );
  });

  it('conta como pago o deposito que o lojista gastou antes das confirmacoes exigidas', async () => {
    const big = await createIntent('t13c', 2_000_000n);
    const funding = 'a3'.repeat(32);
    const esplora = new FakeEsplora();
    // 1 confirmacao; acima de ONCHAIN_HIGH_VALUE_SATS sao exigidas 3.
    esplora.utxos.set(big.onchain!.address, [
      {
        txid: funding,
        vout: 0,
        value: 2_000_000,
        status: { confirmed: true, block_height: 100, block_hash: 'c3'.repeat(32) },
      },
    ]);
    const watcher = new OnchainWatcher({
      repos,
      esplora: esplora as unknown as EsploraClient,
      config,
      logger: silentLogger,
      now: () => now,
    });
    expect((await watcher.runCycle(10)).paid).toBe(0);

    // O lojista gasta; o deposito segue confirmado e ganha confirmacoes.
    esplora.utxos.clear();
    esplora.txs.add(funding);
    esplora.txHeights.set(funding, 100);
    esplora.tip = 102;
    expect((await watcher.runCycle(10)).reorged).toBe(0);
    const paid = await loadIntent(big.id);
    expect(paid?.status).toBe('pago');
    expect(paid?.paidAmountSats).toBe(2_000_000n);
  });

  it('reorga quando o deposito some depois do gasto', async () => {
    const dto = await createIntent('t14');
    const funding = 'd1'.repeat(32);
    const sweepTx = 'e1'.repeat(32);
    const esplora = new FakeEsplora();
    esplora.utxos.set(dto.onchain!.address, [
      {
        txid: funding,
        vout: 0,
        value: 1000,
        status: { confirmed: true, block_height: 100, block_hash: 'f1'.repeat(32) },
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
    const intent = await loadIntent(dto.id);
    const claimed = await repos.claimSweep({
      intentId: intent!.id,
      addressId: intent!.onchainAddressId!,
      amountSats: 900n,
      feeSats: 100n,
      coldWalletAddress: 'bcrt1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      inputs: [{ txid: funding, vout: 0, amountSats: '1000' }],
    });
    await repos.updateSweep({
      id: claimed!.id,
      status: 'aguardando_confirmacao_rede',
      txid: sweepTx,
    });
    await repos.markOnchainPaymentsGasto([
      { txid: funding, vout: 0, amountSats: '1000' },
    ]);
    esplora.txs.add(sweepTx);
    esplora.utxos.clear();
    const cycle = await watcher.runCycle(10);
    expect(cycle.reorged).toBe(1);
    expect((await loadIntent(dto.id))?.status).toBe('reorg');
  });

  it('poeira que sai da mempool nao derruba um Lightning ja pago', async () => {
    const dto = await createIntent('t15');
    lnbits.markPaid(dto.lightning!.payment_hash);
    await service.applyLightningPayment(dto.lightning!.payment_hash);
    const dust = 'ab'.repeat(32);
    const esplora = new FakeEsplora();
    esplora.utxos.set(dto.onchain!.address, [
      {
        txid: dust,
        vout: 0,
        value: 100,
        status: { confirmed: false },
      },
    ]);
    const watcher = new OnchainWatcher({
      repos,
      esplora: esplora as unknown as EsploraClient,
      config,
      logger: silentLogger,
      now: () => now,
    });
    await watcher.runCycle(10);
    esplora.utxos.clear();
    const cycle = await watcher.runCycle(10);
    expect(cycle.reorged).toBe(0);
    expect((await loadIntent(dto.id))?.status).toBe('pago');
    expect((await loadIntent(dto.id))?.paidRail).toBe('lightning');
  });

  it('mempool nao segura o prazo', async () => {
    const dto = (
      await service.create({
        clientId: client.client.id,
        externalId: 't16',
        amountSats: 1000n,
        expiresInSeconds: 30,
      })
    ).dto;
    const intent = await loadIntent(dto.id);
    await repos.upsertOnchainPayment({
      intentId: dto.id,
      addressId: intent!.onchainAddressId!,
      txid: '11'.repeat(32),
      vout: 0,
      amountSats: 1000n,
      blockHeight: null,
      blockHash: null,
      confirmations: 0,
      status: 'mempool',
    });
    now = new Date(now.getTime() + 31_000);
    const result = await service.expireDueIntents(10);
    expect(result.expired).toBe(1);
    expect((await loadIntent(dto.id))?.status).toBe('expirado');
  });

  it('recusa Lightning abaixo da invoice e sem valor', async () => {
    const under = await createIntent('t17');
    lnbits.amountSats = 10;
    lnbits.markPaid(under.lightning!.payment_hash);
    const underResult = await service.applyLightningPayment(under.lightning!.payment_hash);
    expect(underResult.status).toBe('ignorado');
    expect((await loadIntent(under.id))?.status).toBe('pendente');

    const missing = await createIntent('t18');
    lnbits.amountSats = undefined;
    lnbits.omitAmount = true;
    lnbits.markPaid(missing.lightning!.payment_hash);
    const missingResult = await service.applyLightningPayment(missing.lightning!.payment_hash);
    expect(missingResult.status).toBe('ignorado');
    expect((await loadIntent(missing.id))?.status).toBe('pendente');
  });

  it('aceita Lightning em msat e em sats', async () => {
    const msat = await createIntent('t19', 1000n);
    lnbits.amountMsat = 1_000_000;
    lnbits.amountSats = 1000;
    lnbits.markPaid(msat.lightning!.payment_hash);
    expect((await service.applyLightningPayment(msat.lightning!.payment_hash)).status).toBe('pago');

    const sats = await createIntent('t20', 1000n);
    lnbits.amountMsat = 1000;
    lnbits.amountSats = 1;
    lnbits.markPaid(sats.lightning!.payment_hash);
    expect((await service.applyLightningPayment(sats.lightning!.payment_hash)).status).toBe('pago');
  });

  it('recusa reutilizar external_id que ainda esta criando', async () => {
    const dto = await createIntent('t22');
    await db.db
      .update(paymentIntents)
      .set({ status: 'criando' })
      .where(eq(paymentIntents.id, dto.id));
    await expect(createIntent('t22')).rejects.toThrow(/sendo criada/);
  });

  it('soma Lightning que chega depois do on-chain', async () => {
    const dto = await createIntent('t21');
    const esplora = new FakeEsplora();
    esplora.utxos.set(dto.onchain!.address, [
      {
        txid: '22'.repeat(32),
        vout: 0,
        value: 1000,
        status: { confirmed: true, block_height: 100, block_hash: '33'.repeat(32) },
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
    lnbits.markPaid(dto.lightning!.payment_hash);
    const result = await service.applyLightningPayment(dto.lightning!.payment_hash);
    expect(result.status).toBe('ja_processado');
    const intent = await loadIntent(dto.id);
    expect(intent?.paidRail).toBe('both');
    expect(intent?.paidAmountSats).toBe(2000n);
    expect(intent?.status).toBe('pago');
  });
});
