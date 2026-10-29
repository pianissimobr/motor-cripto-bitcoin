import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as btc from '@scure/btc-signer';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAccountXpub, hdVersionsForNetwork, networkFor } from '../src/adapters/hd/derivation.js';
import type { EsploraClient, EsploraTx } from '../src/adapters/chain/esplora.js';
import type { LnbitsClient } from '../src/adapters/lnbits/client.js';
import { BtcLocalSigner } from '../src/adapters/signer/local.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import type { PaymentIntent } from '../src/domain/types.js';
import { silentLogger } from '../src/logger.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import { SweepService } from '../src/services/sweep-service.js';
import {
  TEST_MNEMONIC,
  createTestClient,
  testConfig,
  truncateAll,
  type TestClient,
} from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

class FakeLnbits {
  async createInvoice() {
    return { payment_hash: `sweep-hash-${Date.now()}`, payment_request: 'lnbc-sweep' };
  }
  async getPayment(paymentHash: string) {
    return { payment_hash: paymentHash, paid: false, pending: true, status: 'pending' };
  }
}

class FakeEsplora {
  confirmed = false;
  blockHeight = 100;
  broadcasts: Array<{ raw: string; txid: string }> = [];
  feeEstimates: Record<string, number> = { '6': 10 };

  async getFeeEstimates(): Promise<Record<string, number>> {
    return this.feeEstimates;
  }

  async broadcastTx(raw: string): Promise<string> {
    const tx = btc.Transaction.fromRaw(hex.decode(raw));
    this.broadcasts.push({ raw, txid: tx.id });
    return tx.id;
  }

  async getTx(txid: string): Promise<EsploraTx> {
    return {
      txid,
      status: this.confirmed
        ? { confirmed: true, block_height: this.blockHeight, block_hash: 'b'.repeat(64) }
        : { confirmed: false },
      vout: [],
    };
  }

  async getTipHeight(): Promise<number> {
    return 101;
  }
}

maybeDescribe('sweep service (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let client: TestClient;
  let service: PaymentIntentService;
  let signer: BtcLocalSigner;
  let esplora: FakeEsplora;
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
    client = await createTestClient(repos, config);
    const lnbits = new FakeLnbits();
    service = new PaymentIntentService({
      repos,
      lnbits: lnbits as unknown as LnbitsClient,
      config,
      xpub,
      logger: silentLogger,
    });
    const seed = mnemonicToSeedSync(TEST_MNEMONIC);
    const versions = hdVersionsForNetwork('regtest');
    const account = HDKey.fromMasterSeed(seed, versions).derive("m/84'/0'/0'");
    signer = BtcLocalSigner.fromAccountXprv(account.privateExtendedKey!, 'regtest');
    esplora = new FakeEsplora();
    now = new Date('2026-01-01T00:00:00.000Z');
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  function sweepService() {
    return new SweepService({
      repos,
      esplora: esplora as unknown as EsploraClient,
      signer,
      config,
      logger: silentLogger,
      now: () => now,
    });
  }

  async function createPaidIntent(
    externalId: string,
    amountSats: bigint,
    txid: string,
  ): Promise<PaymentIntent> {
    const created = await service.create({
      clientId: client.client.id,
      externalId,
      amountSats,
      description: 'Sweep test',
    });
    const intent = await repos.findIntentByIdForClient(
      created.dto.id,
      client.client.id,
    );
    if (!intent?.onchainAddressId) throw new Error('intent sem endereco');
    await repos.markIntentPaid({
      intentId: intent.id,
      status: 'pago',
      paidRail: 'onchain',
      paidAmountSats: amountSats,
      overpaidSats: 0n,
      paidAt: now,
    });
    await repos.upsertOnchainPayment({
      intentId: intent.id,
      addressId: intent.onchainAddressId,
      txid,
      vout: 0,
      amountSats,
      blockHeight: 100,
      blockHash: 'b'.repeat(64),
      confirmations: 1,
      status: 'confirmado',
    });
    const updated = await repos.findIntentByIdForClient(intent.id, client.client.id);
    return updated!;
  }

  async function getSweeps() {
    return db.sql`select * from onchain_sweeps order by created_at desc`;
  }

  it('cria, assina e transmite sweep para a carteira fria', async () => {
    const intent = await createPaidIntent('sweep-1', 100_000n, 'a'.repeat(64));
    const result = await sweepService().runCycle(10);
    expect(result.broadcast).toBe(1);
    expect(esplora.broadcasts).toHaveLength(1);

    const sweep = (await getSweeps())[0]!;
    expect(sweep.status).toBe('aguardando_confirmacao_rede');
    expect(sweep.txid).toBe(esplora.broadcasts[0]!.txid);
    expect(Number(sweep.fee_sats)).toBeGreaterThan(0);
    expect(sweep.inputs).toHaveLength(1);
    expect(sweep.last_broadcast_at).not.toBeNull();

    const tx = btc.Transaction.fromRaw(hex.decode(esplora.broadcasts[0]!.raw));
    expect(tx.getOutputAddress(0, networkFor('regtest'))).toBe(
      config.sweep.coldWalletAddress,
    );
    const outputAmount = tx.getOutput(0).amount!;
    expect(outputAmount).toBe(100_000n - BigInt(sweep.fee_sats));

    const payment = (await db.sql`
      select status from onchain_payments where intent_id = ${intent.id}
    `)[0]!;
    expect(payment.status).toBe('gasto');

    // O watcher nao pode reabrir o UTXO como confirmado enquanto o sweep
    // ainda esta em andamento; isso evita um falso reorg/double sweep.
    await repos.upsertOnchainPayment({
      intentId: intent.id,
      addressId: intent.onchainAddressId!,
      txid: 'a'.repeat(64),
      vout: 0,
      amountSats: 100_000n,
      blockHeight: 100,
      blockHash: 'b'.repeat(64),
      confirmations: 1,
      status: 'confirmado',
    });
    const afterUpsert = (await db.sql`
      select status from onchain_payments where intent_id = ${intent.id}
    `)[0]!;
    expect(afterUpsert.status).toBe('gasto');

    await repos.restoreOnchainPayments(sweep.inputs);
    const restored = (await db.sql`
      select status from onchain_payments where intent_id = ${intent.id}
    `)[0]!;
    expect(restored.status).toBe('confirmado');
  });

  it('monitora e confirma o sweep', async () => {
    await createPaidIntent('sweep-2', 100_000n, 'c'.repeat(64));
    const sweeper = sweepService();
    await sweeper.runCycle(10);
    esplora.confirmed = true;
    const result = await sweeper.runCycle(10);
    expect(result.swept).toBe(1);
    const sweep = (await getSweeps())[0]!;
    expect(sweep.status).toBe('sweepado');
    expect(Number(sweep.confirmations)).toBe(2);
  });

  it('marca como manual quando taxa/poeira tornam o sweep inviavel', async () => {
    await createPaidIntent('sweep-3', 600n, 'd'.repeat(64));
    const result = await sweepService().runCycle(10);
    expect(result.manual).toBe(1);
    const sweep = (await getSweeps())[0]!;
    expect(sweep.status).toBe('manual');
    expect(sweep.last_error).toContain('abaixo do minimo');
    expect(esplora.broadcasts).toHaveLength(0);
  });

  it('reenvia com RBF quando o sweep demora a confirmar', async () => {
    await createPaidIntent('sweep-4', 100_000n, 'e'.repeat(64));
    const sweeper = sweepService();
    await sweeper.runCycle(10);
    const first = (await getSweeps())[0]!;
    const firstTxid = first.txid;
    const firstFee = BigInt(first.fee_sats);

    now = new Date(now.getTime() + (config.sweep.rbfAfterSeconds + 1) * 1000);
    const result = await sweeper.runCycle(10);
    expect(result.rbf).toBe(1);

    const second = (await getSweeps())[0]!;
    expect(second.txid).not.toBe(firstTxid);
    expect(Number(second.attempts)).toBe(1);
    expect(BigInt(second.fee_sats)).toBeGreaterThan(firstFee);
    expect(esplora.broadcasts).toHaveLength(2);
  });
});
