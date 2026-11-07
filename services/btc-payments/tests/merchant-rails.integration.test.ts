import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import type { MerchantWallet } from '../src/domain/types.js';
import { silentLogger } from '../src/logger.js';
import {
  createLightningWallet,
  createLnbitsFactory,
  type MerchantLnbits,
} from '../src/services/merchant-lightning.js';
import { MerchantWalletService } from '../src/services/merchant-wallet-service.js';
import { WalletChangeNotifier } from '../src/services/wallet-change-notifier.js';
import { sql } from 'drizzle-orm';
import { PaymentIntentService } from '../src/services/payment-intent-service.js';
import {
  addBitcoinWallets,
  createTestClient,
  testConfig,
  truncateAll,
  type TestClient,
} from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

/** LNbits falso por wallet: registra em qual wallet cada operacao ocorreu. */
class FakeLnbitsPool {
  readonly calls: Array<{ walletId: string; op: 'create' | 'get' }> = [];
  healthy = true;
  adminKey: boolean | null = false;
  private counter = 0;
  private paid = new Set<string>();

  forWallet = (wallet: MerchantWallet): MerchantLnbits => ({
    createInvoice: async () => {
      this.calls.push({ walletId: wallet.id, op: 'create' });
      const hash = `hash-rails-${++this.counter}`;
      return { payment_hash: hash, payment_request: `lnbc-${hash}` };
    },
    getPayment: async (hash: string) => {
      this.calls.push({ walletId: wallet.id, op: 'get' });
      return { payment_hash: hash, paid: this.paid.has(hash), amount_msat: 1000 };
    },
    health: async () => (this.healthy ? { ok: true } : { ok: false, detail: 'chave invalida' }),
    isAdminKey: async () => this.adminKey,
  });

  markPaid(hash: string) {
    this.paid.add(hash);
  }
}

maybeDescribe('trilhos por carteira do lojista (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let pool: FakeLnbitsPool;
  let service: PaymentIntentService;
  let client: TestClient;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig();
    pool = new FakeLnbitsPool();
    service = new PaymentIntentService({
      repos,
      lnbitsFor: pool.forWallet,
      config,
      logger: silentLogger,
    });
    client = await createTestClient(repos, config);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  const create = (externalId: string) =>
    service.create({ clientId: client.client.id, externalId, amountSats: 1000n });

  it('sem carteira Bitcoin do lojista a cobranca e recusada', async () => {
    await expect(create('sem-carteira')).rejects.toMatchObject({
      code: 'bitcoin_wallet_required',
      statusCode: 409,
    });
  });

  it('so Lightning: invoice na wallet LNbits do lojista, sem endereco on-chain', async () => {
    const { lightningWalletId } = await addBitcoinWallets(db, config, client.client.id, {
      onchain: false,
    });
    const { dto } = await create('so-ln');
    expect(dto.lightning?.invoice).toBeTruthy();
    expect(dto.onchain).toBeNull();
    expect(pool.calls).toEqual([{ walletId: lightningWalletId, op: 'create' }]);
  });

  it('so on-chain: endereco do xpub do lojista, sem invoice', async () => {
    const { btcWalletId } = await addBitcoinWallets(db, config, client.client.id, {
      lightning: false,
    });
    const { dto } = await create('so-onchain');
    expect(dto.lightning).toBeNull();
    expect(dto.onchain?.address).toMatch(/^bcrt1q/);
    const intent = await repos.findIntentById(dto.id);
    expect(intent?.merchantWalletId).toBe(btcWalletId);
    expect(pool.calls).toHaveLength(0);
  });

  it('confere o pagamento na wallet onde a invoice foi criada, mesmo apos trocar de wallet', async () => {
    const { lightningWalletId: first } = await addBitcoinWallets(db, config, client.client.id, {
      onchain: false,
    });
    const { dto } = await create('troca-wallet');
    // O lojista troca de wallet LNbits depois de emitir a invoice.
    const { lightningWalletId: second } = await addBitcoinWallets(db, config, client.client.id, {
      onchain: false,
    });
    expect(second).not.toBe(first);

    pool.markPaid(dto.lightning!.payment_hash);
    const result = await service.applyLightningPayment(dto.lightning!.payment_hash);
    expect(result.status).toBe('pago');
    expect(pool.calls.at(-1)).toEqual({ walletId: first, op: 'get' });

    const next = await create('depois-da-troca');
    expect(next.dto.lightning).toBeTruthy();
    expect(pool.calls.at(-1)).toEqual({ walletId: second, op: 'create' });
  });

  it('cadastra a wallet LNbits so se a Invoice key funciona e guarda a chave cifrada', async () => {
    const wallets = new MerchantWalletService(db.db);
    const services = { config, repos, wallets, lnbitsFor: pool.forWallet };
    const body = { lnbits_url: 'http://127.0.0.1:5999/', invoice_key: 'invoice-key-secreta-123' };

    pool.healthy = false;
    await expect(createLightningWallet(services, client.client.id, body)).rejects.toMatchObject({
      code: 'validation_error',
    });

    pool.healthy = true;
    // Admin key (gasta o saldo) e recusada; a plataforma so guarda Invoice key.
    pool.adminKey = true;
    await expect(createLightningWallet(services, client.client.id, body)).rejects.toThrow(
      /Admin key/,
    );
    pool.adminKey = false;
    const wallet = await createLightningWallet(services, client.client.id, body);
    expect(wallet.kind).toBe('lightning_lnbits');
    expect(wallet.lnbitsUrl).toBe('http://127.0.0.1:5999');
    expect(wallet.secretEnc).not.toContain('invoice-key-secreta-123');

    // A chave cifrada abre o cliente real com a Invoice key original.
    const real = createLnbitsFactory(config, silentLogger)(wallet) as unknown as {
      apiKey: string;
    };
    expect(real.apiKey).toBe('invoice-key-secreta-123');
  });

  it('gap limit: sem on-chain quando o xpub tem enderecos demais sem uso', async () => {
    const { btcWalletId } = await addBitcoinWallets(db, config, client.client.id, {
      lightning: false,
    });
    await db.db.execute(
      sql`update merchant_wallet_state set next_receive_index = ${config.btc.gapLimit} where wallet_id = ${btcWalletId}`,
    );
    // So on-chain: a cobranca e recusada com o motivo.
    await expect(create('gap-so-onchain')).rejects.toMatchObject({ code: 'gap_limit_reached' });

    // Com Lightning, a cobranca sai so com Lightning.
    await addBitcoinWallets(db, config, client.client.id, { onchain: false });
    const { dto } = await create('gap-com-ln');
    expect(dto.onchain).toBeNull();
    expect(dto.lightning).toBeTruthy();
  });

  it('avisa a loja e registra auditoria quando a carteira muda', async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    const notifier = new WalletChangeNotifier({
      repos,
      logger: silentLogger,
      emailSender: {
        async sendSecurityNotice(input) {
          sent.push({ to: input.to, subject: input.subject });
        },
      },
    });
    const { lightningWalletId } = await addBitcoinWallets(db, config, client.client.id, {
      onchain: false,
    });
    const wallet = (await repos.findMerchantWalletById(lightningWalletId!))!;
    await notifier.notify({ merchantId: client.client.id, wallet, action: 'cadastrada', actor: 'api' });

    const events = await repos.listWebhookEvents(10);
    const event = events.find((e) => e.eventType === 'merchant.wallet_changed');
    expect(event?.clientId).toBe(client.client.id);
    expect((event?.payload as { data: { action: string; kind: string } }).data).toMatchObject({
      action: 'cadastrada',
      kind: 'lightning_lnbits',
    });
    // Sem membros cadastrados nesta loja de teste: nenhum e-mail.
    expect(sent).toHaveLength(0);
  });
});
