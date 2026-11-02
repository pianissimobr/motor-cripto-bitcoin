import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { LuniumClient, type LuniumCharge } from '../src/adapters/lunium/client.js';
import { signWebhook } from '../src/crypto/hmac.js';
import type { UsdcPayoutAdapter } from '../src/adapters/payout/base-usdc.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { merchantAccountCode } from '../src/domain/ledger.js';
import { LedgerService } from '../src/ledger/ledger-service.js';
import { silentLogger } from '../src/logger.js';
import { MerchantWalletService } from '../src/services/merchant-wallet-service.js';
import { PayoutService } from '../src/services/payout-service.js';
import { PixChargeService } from '../src/services/pix-charge-service.js';
import { LuniumWebhookService } from '../src/services/lunium-webhook-service.js';
import { testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;
const USDC_WALLET = '0x1111111111111111111111111111111111111111';
const USDC_HOT = '0x2222222222222222222222222222222222222222';
const BASE_TXID = `0x${'b'.repeat(64)}`;

function fakePayoutAdapter(options: { reverted?: boolean } = {}): UsdcPayoutAdapter {
  return {
    getAddress: () => USDC_HOT as Address,
    async getGasBalanceWei() {
      return 1_000_000_000_000_000_000n;
    },
    async transfer() {
      return { kind: 'sent', txid: BASE_TXID };
    },
    async getConfirmation() {
      return {
        confirmed: !options.reverted,
        reverted: options.reverted ?? false,
        blockNumber: 1n,
      };
    },
    describe() {
      return 'fake';
    },
  };
}

class FakeLunium {
  counter = 0;
  createCalls = 0;
  failCreate = false;
  charge: LuniumCharge = {
    cashin_id: 'ci_test_1',
    status: 'pending',
    settlement_status: 'pending',
    amount_cents: 2500,
    asset: 'USDC',
    chain: 'base',
    qr_copypaste: '000201-pix-code',
    qr_image_url: 'https://img.test/qr.png',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  };

  async getLimits() {
    return { max_amount_cents: 250_000 };
  }

  async createCharge() {
    this.createCalls++;
    if (this.failCreate) {
      throw new Error('timeout simulado');
    }
    this.counter++;
    this.charge = {
      ...this.charge,
      cashin_id: `ci_test_${this.counter}`,
    };
    return this.charge;
  }

  async getCharge() {
    return this.charge;
  }

  async findChargesByExternalId() {
    return [this.charge];
  }
}

maybeDescribe('PIX -> USDC (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let ledger: LedgerService;
  let wallets: MerchantWalletService;
  let pixCharges: PixChargeService;
  let payouts: PayoutService;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({
      PIX_ENABLED: 'true',
      LUNIUM_API_KEY: 'lun_test_key',
      LUNIUM_WEBHOOK_SECRET: 'lunium-webhook-secret',
      TREASURY_USDC_ADDRESS: USDC_WALLET,
      PAYOUT_ENABLED: 'true',
      PAYOUT_NEW_WALLET_CARE_SECONDS: '0',
    });
    ledger = new LedgerService(db.db);
    wallets = new MerchantWalletService(db.db);
    const fake = new FakeLunium();
    pixCharges = new PixChargeService({
      repos,
      ledger,
      lunium: fake as unknown as LuniumClient,
      config,
      logger: silentLogger,
    });
    payouts = new PayoutService({
      repos,
      ledger,
      adapter: fakePayoutAdapter(),
      config,
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function createMerchant(
    name: string,
    withWallet = true,
  ): Promise<string> {
    const clientId = (await repos.createClient({
      id: crypto.randomUUID(),
      name,
      apiKeyPrefix: 'mk_test',
      apiKeyHash: `hash-${crypto.randomUUID()}`,
      requestSecretEnc: 'secret',
      webhookUrl: 'http://localhost:9999/webhook',
      webhookSecretEnc: 'secret',
    })).id;
    if (withWallet) {
      await wallets.createUsdcSettlement({
        merchantId: clientId,
        address: USDC_WALLET,
        chain: 'base',
        network: 'base',
      });
    }
    return clientId;
  }

  function fakeLunium(): FakeLunium {
    return (pixCharges as unknown as { deps: { lunium: FakeLunium } }).deps.lunium;
  }

  it('processa webhook assinado e sincroniza a cobranca', async () => {
    const clientId = (await repos.createClient({
      id: crypto.randomUUID(),
      name: 'loja webhook pix',
      apiKeyPrefix: 'mk_test',
      apiKeyHash: 'hash-webhook',
      requestSecretEnc: 'secret',
      webhookUrl: 'http://localhost:9999/webhook',
      webhookSecretEnc: 'secret',
    })).id;
    const fake = new FakeLunium();
    const lunium = new LuniumClient({
      apiUrl: 'https://lunium.test',
      apiKey: 'lun_test_key',
      webhookSecret: 'lunium-webhook-secret',
      timeoutMs: 5_000,
      fetchImpl: async (url) => {
        if (String(url).includes('/cashin/limits')) {
          return new Response(JSON.stringify({ max_amount_cents: 250_000 }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify(fake.charge), { status: 200 });
      },
    });
    const service = new PixChargeService({
      repos,
      ledger,
      lunium,
      config,
      logger: silentLogger,
    });
    const webhook = new LuniumWebhookService({
      repos,
      lunium,
      pixCharges: service,
      config,
      logger: silentLogger,
    });
    const created = await service.create({
      clientId,
      externalId: 'pedido-webhook-1',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });

    fake.charge = {
      ...fake.charge,
      status: 'paid',
      settlement_status: 'sent',
      asset_amount: '2.45',
    };
    const payload = {
      event: 'cashin.settled',
      event_id: 'evt_pix_1',
      created_at: new Date().toISOString(),
      data: {
        cashin_id: created.dto.provider_charge_id,
        status: 'paid',
        settlement_status: 'sent',
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(
      'lunium-webhook-secret',
      Math.floor(Date.now() / 1000),
      rawBody,
    );

    await webhook.receive({
      signature,
      eventId: 'evt_pix_1',
      rawBody,
    });
    await webhook.receive({
      signature,
      eventId: 'evt_pix_1',
      rawBody,
    });
    expect(await webhook.processPending(10)).toMatchObject({
      checked: 1,
      processed: 1,
      errors: 0,
    });
    const current = await service.getById(clientId, created.dto.id);
    expect(current.status).toBe('liquidado');
  });

  it('marca expirado, reembolsado e falhou conforme o provider', async () => {
    const clientId = await createMerchant('loja estados pix');
    const fake = fakeLunium();
    const expired = await pixCharges.create({
      clientId,
      externalId: 'pix-expired',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });
    fake.charge = {
      ...fake.charge,
      status: 'expired',
      settlement_status: 'pending',
    };
    expect((await pixCharges.sync(expired.dto.id)).status).toBe('expirado');

    fake.charge = {
      ...fake.charge,
      status: 'pending',
      settlement_status: 'pending',
    };
    const refunded = await pixCharges.create({
      clientId,
      externalId: 'pix-refunded',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });
    fake.charge = {
      ...fake.charge,
      status: 'refunded',
      settlement_status: 'failed',
    };
    expect((await pixCharges.sync(refunded.dto.id)).status).toBe('reembolsado');

    fake.charge = {
      ...fake.charge,
      status: 'pending',
      settlement_status: 'pending',
    };
    const failed = await pixCharges.create({
      clientId,
      externalId: 'pix-failed',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });
    fake.charge = {
      ...fake.charge,
      status: 'failed',
      settlement_status: 'failed',
    };
    expect((await pixCharges.sync(failed.dto.id)).status).toBe('falhou');
  });

  it('reconcilia cobranca paga sem webhook', async () => {
    const clientId = await createMerchant('loja reconcile pix');
    const created = await pixCharges.create({
      clientId,
      externalId: 'pix-reconcile',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });
    fakeLunium().charge = {
      ...fakeLunium().charge,
      status: 'paid',
      settlement_status: 'sent',
      asset_amount: '2.45',
    };

    expect(await pixCharges.reconcile(10)).toMatchObject({
      checked: 1,
      synced: 1,
      errors: 0,
    });
    expect((await pixCharges.getById(clientId, created.dto.id)).status).toBe(
      'liquidado',
    );
  });

  it('marca manual quando a loja nao tem carteira USDC', async () => {
    const clientId = await createMerchant('loja sem carteira pix', false);
    const created = await pixCharges.create({
      clientId,
      externalId: 'pix-sem-carteira',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });
    fakeLunium().charge = {
      ...fakeLunium().charge,
      status: 'paid',
      settlement_status: 'sent',
      asset_amount: '2.45',
    };
    await pixCharges.sync(created.dto.id);

    expect(await payouts.createPixPayouts(10)).toMatchObject({
      created: 0,
      errors: 1,
    });
    const current = await pixCharges.getById(clientId, created.dto.id);
    expect(current.settlement_status).toBe('manual');
    expect(current.payout_id).toBeNull();
  });

  it('timeout nao cria cobranca duplicada no retry', async () => {
    const clientId = await createMerchant('loja timeout pix');
    const fake = fakeLunium();
    fake.failCreate = true;

    await expect(
      pixCharges.create({
        clientId,
        externalId: 'pix-timeout',
        amountBrlCents: 2_500n,
        payerTaxNumber: '00000000191',
      }),
    ).rejects.toMatchObject({ code: 'upstream_error' });

    const pending = await repos.findPixChargeByClientAndExternalId(
      clientId,
      'pix-timeout',
    );
    expect(pending?.status).toBe('incerto');

    fake.failCreate = false;
    const retry = await pixCharges.create({
      clientId,
      externalId: 'pix-timeout',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });
    expect(retry.reused).toBe(true);
    expect(retry.dto.id).toBe(pending?.id);
    expect(fake.createCalls).toBe(1);
  });

  it('gera QR SVG local quando o provider nao retorna imagem', async () => {
    const clientId = await createMerchant('loja qr local');
    fakeLunium().charge = {
      ...fakeLunium().charge,
      qr_image_url: null,
    };
    const created = await pixCharges.create({
      clientId,
      externalId: 'pix-qr-local',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });
    expect(created.dto.pix.qr_svg).toContain('<svg');
  });

  it('payout revertido de PIX vai para revisao manual', async () => {
    const clientId = await createMerchant('loja reversao pix');
    const created = await pixCharges.create({
      clientId,
      externalId: 'pix-revert',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });
    fakeLunium().charge = {
      ...fakeLunium().charge,
      status: 'paid',
      settlement_status: 'sent',
      asset_amount: '2.45',
    };
    await pixCharges.sync(created.dto.id);
    await payouts.createPixPayouts(10);
    await payouts.sendApproved(10);

    const reverting = new PayoutService({
      repos,
      ledger,
      adapter: fakePayoutAdapter({ reverted: true }),
      config,
      logger: silentLogger,
    });
    expect(await reverting.monitor(10)).toMatchObject({ failed: 1 });

    const current = await pixCharges.getById(clientId, created.dto.id);
    expect(current.status).toBe('manual');
    expect(current.settlement_status).toBe('manual');
  });

  it('cria cobranca PIX idempotente, liquida em ledger e cria payout USDC', async () => {
    const clientId = (await repos.createClient({
      id: crypto.randomUUID(),
      name: 'loja pix',
      apiKeyPrefix: 'mk_test',
      apiKeyHash: 'hash',
      requestSecretEnc: 'secret',
      webhookUrl: 'http://localhost:9999/webhook',
      webhookSecretEnc: 'secret',
    })).id;
    await wallets.createUsdcSettlement({
      merchantId: clientId,
      address: USDC_WALLET,
      chain: 'base',
      network: 'base',
    });

    const created = await pixCharges.create({
      clientId,
      externalId: 'pedido-pix-1',
      amountBrlCents: 2_500n,
      payerTaxNumber: '000.000.001-91',
    });
    expect(created.reused).toBe(false);
    expect(created.dto.status).toBe('pendente');
    expect(created.dto.pix.qr_copypaste).toBe('000201-pix-code');

    const reused = await pixCharges.create({
      clientId,
      externalId: 'pedido-pix-1',
      amountBrlCents: 2_500n,
      payerTaxNumber: '00000000191',
    });
    expect(reused.reused).toBe(true);
    expect(reused.dto.id).toBe(created.dto.id);

    const fake = (pixCharges as unknown as { deps: { lunium: FakeLunium } }).deps.lunium;
    fake.charge = {
      ...fake.charge,
      status: 'paid',
      settlement_status: 'sent',
      settled_at: new Date().toISOString(),
      asset_amount: '2.45',
      settlement_tx_hash: BASE_TXID,
    };

    const settled = await pixCharges.sync(created.dto.id);
    expect(settled.status).toBe('liquidado');
    expect(settled.settlement_status).toBe('convertido');

    const balances = await ledger.getMerchantBalances(clientId);
    const usdc = balances.find(
      (item) => item.accountCode === merchantAccountCode(clientId, 'usdc_available'),
    );
    expect(usdc?.balance).toBe(2_450_000n);

    expect(await payouts.createPixPayouts(10)).toMatchObject({
      created: 1,
      automatic: 1,
    });
    expect(await payouts.sendApproved(10)).toMatchObject({ sent: 1 });
    expect(await payouts.monitor(10)).toMatchObject({ confirmed: 1 });

    const final = await pixCharges.getById(clientId, created.dto.id);
    expect(final.settlement_status).toBe('pago');
    expect(final.payout_id).toBeTruthy();
  });
});
