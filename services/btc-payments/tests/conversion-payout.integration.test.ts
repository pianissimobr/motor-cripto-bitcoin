import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { parseAccountXpub } from '../src/adapters/hd/derivation.js';
import type { LnbitsClient } from '../src/adapters/lnbits/client.js';
import type { SwapQuote, SwapStatus } from '../src/adapters/conversion/thorchain.js';
import type { UsdcPayoutAdapter } from '../src/adapters/payout/base-usdc.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { merchantAccountCode, PLATFORM_ACCOUNTS } from '../src/domain/ledger.js';
import { LedgerService } from '../src/ledger/ledger-service.js';
import { silentLogger } from '../src/logger.js';
import { ConversionService } from '../src/services/conversion-service.js';
import { MerchantWalletService } from '../src/services/merchant-wallet-service.js';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import { PayoutService } from '../src/services/payout-service.js';
import {
  createTestClient,
  testConfig,
  testTpub,
  truncateAll,
  type TestClient,
} from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;
const USDC_WALLET = '0x1111111111111111111111111111111111111111';
const USDC_HOT = '0x2222222222222222222222222222222222222222';
const BTC_TXID = 'a'.repeat(64);
const BASE_TXID = `0x${'b'.repeat(64)}`;

class FakeLnbits {
  private counter = 0;

  async createInvoice() {
    const paymentHash = `hash-conv-${++this.counter}`;
    return {
      payment_hash: paymentHash,
      payment_request: `lnbc-conv-${paymentHash}`,
    };
  }
}

function fakeSwap(expectedOut = 50_000_000n): {
  quote: (input: unknown) => Promise<SwapQuote>;
  getStatus: (txid: string) => Promise<SwapStatus>;
} {
  return {
    async quote() {
      return {
        provider: 'thorchain',
        providerOrderId: 'quote-1',
        inboundAddress: 'bc1qinboundvault',
        memo: 'SWAP:BASE.USDC:dest:limit/0/0',
        expectedAmountOutMinor: expectedOut,
        expiresAt: new Date(Date.now() + 600_000),
        sourceUrl: 'https://thor.example',
        raw: { expected_amount_out: '5000000000' },
      };
    },
    async getStatus() {
      return {
        done: true,
        failed: false,
        refunded: false,
        outboundTxid: BASE_TXID,
        outboundAmountMinor: expectedOut,
        raw: { outbound_observed: { tx: { status: 'done' } } },
      };
    },
  };
}

function fakeSender() {
  return {
    async send() {
      return { kind: 'sent' as const, txid: BTC_TXID };
    },
    describe() {
      return 'fake';
    },
  };
}

function fakePayoutAdapter(): UsdcPayoutAdapter {
  return {
    getAddress: () => USDC_HOT as Address,
    async getGasBalanceWei() {
      return 1_000_000_000_000_000_000n;
    },
    async transfer() {
      return { kind: 'sent', txid: BASE_TXID };
    },
    async getConfirmation() {
      return { confirmed: true, reverted: false, blockNumber: 1n };
    },
    describe() {
      return 'fake';
    },
  };
}

maybeDescribe('conversion and payout (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let ledger: LedgerService;
  let wallets: MerchantWalletService;
  let intents: PaymentIntentService;
  let client: TestClient;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({
      CONVERSION_ENABLED: 'true',
      CONVERSION_MIN_SATS: '1000',
      PAYOUT_ENABLED: 'true',
      PAYOUT_NEW_WALLET_CARE_SECONDS: '0',
    });
    ledger = new LedgerService(db.db);
    wallets = new MerchantWalletService(db.db);
    intents = new PaymentIntentService({
      repos,
      lnbits: new FakeLnbits() as unknown as LnbitsClient,
      config,
      xpub: parseAccountXpub(config.btc.xpub, config.btc.network),
      logger: silentLogger,
    });
    client = await createTestClient(repos, config);
    await wallets.createBtcDeposit({
      merchantId: client.client.id,
      xpub: testTpub(),
      derivationPrefix: config.btc.derivationPrefix,
      network: config.btc.network,
      gapLimit: config.btc.gapLimit,
    });
    await wallets.createUsdcSettlement({
      merchantId: client.client.id,
      address: USDC_WALLET,
      chain: 'base',
      network: 'base',
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function paidIntent(externalId: string) {
    const created = await intents.create({
      clientId: client.client.id,
      externalId,
      amountSats: 100_000n,
    });
    const paid = await repos.markIntentPaid({
      intentId: created.dto.id,
      status: 'pago',
      paidRail: 'onchain',
      paidAmountSats: 100_000n,
      overpaidSats: 0n,
      paidAt: new Date(),
    });
    expect(paid).not.toBeNull();
    return created.dto.id;
  }

  it('cria quote, envia BTC, conclui swap e grava ledger', async () => {
    const intentId = await paidIntent('conv-1');
    const service = new ConversionService({
      repos,
      ledger,
      swap: fakeSwap(),
      sender: fakeSender(),
      config,
      logger: silentLogger,
    });

    expect((await service.createOrders(10)).created).toBe(1);
    expect((await service.quoteOrders(10)).quoted).toBe(1);
    expect((await service.sendOrders(10)).sent).toBe(1);
    expect((await service.pollOrders(10)).converted).toBe(1);

    const order = await repos.findConversionOrderByIntentId(intentId);
    expect(order?.status).toBe('convertida');
    expect(order?.targetAmountMinor).toBe(50_000_000n);
    expect(order?.txids).toEqual([BTC_TXID]);

    const intent = await repos.findIntentById(intentId);
    expect(intent?.settlementStatus).toBe('convertido');
    expect(intent?.conversionOrderId).toBe(order?.id);

    const merchant = await ledger.getAccountTotals(
      merchantAccountCode(client.client.id, 'usdc_available'),
      'USDC',
    );
    expect(merchant.credit).toBe(50_000_000n);

    const btcReceivable = await ledger.getAccountTotals(
      merchantAccountCode(client.client.id, 'btc_receivable'),
      'BTC',
    );
    expect(btcReceivable.credit).toBe(100_000n);
    expect(btcReceivable.debit).toBe(100_000n);
    expect(
      await repos.hasProviderEvent('thorchain', `${order?.id}:completed`),
    ).toBe(true);
    const events = await repos.listWebhookEvents(50);
    expect(events.some((event) => event.eventType === 'payment_intent.converted')).toBe(
      true,
    );
  });

  it('exige aprovacao acima do limite e paga apos approve', async () => {
    const intentId = await paidIntent('conv-3');
    const order = await repos.createConversionOrder({
      merchantId: client.client.id,
      intentId,
      sourceAmountSats: 100_000n,
      provider: 'thorchain',
    });
    await repos.updateConversionOrder({
      id: order.id,
      status: 'convertida',
      targetAmountMinor: 2_500_000_000n,
    });
    await repos.updateIntentSettlement({
      intentId,
      from: ['nao_iniciado'],
      to: 'convertido',
      conversionOrderId: order.id,
    });
    await ledger.postTransaction({
      kind: 'conversion_completed',
      referenceType: 'conversion_order',
      referenceId: order.id,
      entries: [
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryUsdc,
          asset: 'USDC',
          debitMinor: 2_500_000_000n,
        },
        {
          accountCode: merchantAccountCode(client.client.id, 'usdc_available'),
          merchantId: client.client.id,
          asset: 'USDC',
          creditMinor: 2_500_000_000n,
        },
      ],
    });

    const service = new PayoutService({
      repos,
      ledger,
      adapter: fakePayoutAdapter(),
      config,
      logger: silentLogger,
    });

    const created = await service.runCycle(10);
    expect(created.created).toBe(1);
    expect(created.manualApproval).toBe(1);
    expect(created.sent).toBe(0);

    const pending = await repos.findPayoutByConversionId(order.id);
    expect(pending?.status).toBe('pendente');
    expect((await repos.findIntentById(intentId))?.settlementStatus).toBe(
      'payout_pendente',
    );

    await service.approve(pending!.id, 'admin');
    expect((await service.sendApproved(10)).sent).toBe(1);
    expect((await service.monitor(10)).confirmed).toBe(1);

    const paid = await repos.findPayoutById(pending!.id);
    expect(paid?.status).toBe('confirmado');
    expect(paid?.approvedBy).toBe('admin');
    expect((await repos.findIntentById(intentId))?.settlementStatus).toBe('pago');
  });

  it('cria payout automatico, envia USDC e confirma na Base', async () => {
    const intentId = await paidIntent('conv-2');
    const order = await repos.createConversionOrder({
      merchantId: client.client.id,
      intentId,
      sourceAmountSats: 100_000n,
      provider: 'thorchain',
    });
    await repos.updateConversionOrder({
      id: order.id,
      status: 'convertida',
      targetAmountMinor: 50_000_000n,
    });
    await repos.updateIntentSettlement({
      intentId,
      from: ['nao_iniciado'],
      to: 'convertido',
      conversionOrderId: order.id,
    });
    await ledger.postTransaction({
      kind: 'conversion_completed',
      referenceType: 'conversion_order',
      referenceId: order.id,
      entries: [
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryUsdc,
          asset: 'USDC',
          debitMinor: 50_000_000n,
        },
        {
          accountCode: merchantAccountCode(client.client.id, 'usdc_available'),
          merchantId: client.client.id,
          asset: 'USDC',
          creditMinor: 50_000_000n,
        },
      ],
    });

    const service = new PayoutService({
      repos,
      ledger,
      adapter: fakePayoutAdapter(),
      config,
      logger: silentLogger,
    });

    const result = await service.runCycle(10);
    expect(result.created).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.confirmed).toBe(1);

    const payout = await repos.findPayoutByConversionId(order.id);
    expect(payout?.status).toBe('confirmado');
    expect(payout?.txid).toBe(BASE_TXID);
    expect(payout?.destinationAddress).toBe(USDC_WALLET);

    const intent = await repos.findIntentById(intentId);
    expect(intent?.settlementStatus).toBe('pago');

    const merchant = await ledger.getAccountTotals(
      merchantAccountCode(client.client.id, 'usdc_available'),
      'USDC',
    );
    expect(merchant.credit).toBe(50_000_000n);
    expect(merchant.debit).toBe(50_000_000n);

    const treasury = await ledger.getAccountTotals(
      PLATFORM_ACCOUNTS.treasuryUsdc,
      'USDC',
    );
    expect(treasury.debit).toBe(50_000_000n);
    expect(treasury.credit).toBe(50_000_000n);
    const events = await repos.listWebhookEvents(50);
    expect(
      events.some((event) => event.eventType === 'payment_intent.payout_confirmed'),
    ).toBe(true);
  });
});
