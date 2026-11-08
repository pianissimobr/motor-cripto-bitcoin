import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { silentLogger } from '../src/logger.js';
import { InvoiceService } from '../src/services/invoice-service.js';
import { createTestClient, testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;
const WALLET = '0x4cd01696cd0165d6020ab7d8ae866fdf2fed3855';

type Log = { transactionHash: string; logIndex: number; value: bigint; blockNumber: bigint };

maybeDescribe('fatura: trilho USDC direto (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let chain: { height: bigint; logs: Log[]; getBlockNumber: () => Promise<bigint>; getTransferLogs: (i: { recipient: string; fromBlock: bigint; toBlock: bigint }) => Promise<Log[]> };
  let now: Date;
  let invoices: InvoiceService;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({ SETTLEMENT_CONFIRMATIONS: '12' });
    now = new Date();
    chain = {
      height: 1_000n,
      logs: [],
      getBlockNumber: async () => chain.height,
      getTransferLogs: async ({ recipient, fromBlock, toBlock }) => {
        expect(recipient).toBe(WALLET);
        return chain.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
    };
    invoices = new InvoiceService({
      db: db.db,
      repos,
      config,
      logger: silentLogger,
      chain,
      // BTC a R$ 500.000 e US$ 100.000: dolar a R$ 5.
      prices: { getBtcPrice: async (c) => ({ btcPriceCents: c === 'BRL' ? 50_000_000n : 10_000_000n }) },
      now: () => now,
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function liveInvoice(orderId = 'u1', price = '100.00') {
    const { client } = await createTestClient(repos, config);
    await db.db.execute(
      `insert into merchant_wallets (merchant_id, kind, purpose, chain, network, address, status, is_default)
       values ('${client.id}', 'usdc_settlement', 'loja', 'polygon', 'polygon', '${WALLET}', 'ativo', true)` as never,
    );
    const { invoice } = await invoices.create(client, null, 'live', { priceAmount: price, priceCurrency: 'BRL', orderId });
    return invoice;
  }

  it('fixa valor unico, espera confirmacoes e marca paga com o hash', async () => {
    const inv = await liveInvoice();
    expect(inv.rails).toContain('usdc');
    const payment = await invoices.chooseUsdc(inv.id);
    expect(payment).toMatchObject({ rail: 'usdc', network: 'Polygon' });
    const amount = (payment as { amount_usdc: string }).amount_usdc;
    // R$ 100 / 5 = 20 USDC, mais os "centavos de centavo" unicos.
    expect(amount).toMatch(/^20\.00\d{4}$/);
    expect(amount).not.toBe('20.000000');
    const minor = BigInt(amount.replace('.', ''));

    // Valor diferente nao paga.
    chain.logs.push({ transactionHash: '0x' + 'a'.repeat(64), logIndex: 0, value: 20_000_000n, blockNumber: 1_005n });
    // Valor exato, ainda raso.
    chain.logs.push({ transactionHash: '0x' + 'b'.repeat(64), logIndex: 3, value: minor, blockNumber: 1_010n });
    chain.height = 1_015n;
    let row = await invoices.sync((await invoices.findPublic(inv.id))!);
    expect(row.status).toBe('aguardando');

    chain.height = 1_030n;
    row = await invoices.sync((await invoices.findPublic(inv.id))!);
    expect(row).toMatchObject({ status: 'pago', paidRail: 'usdc', txHash: '0x' + 'b'.repeat(64) });
    // A transferencia fica reservada para esta fatura.
    expect(await repos.isSwapDeliveryClaimed('0x' + 'b'.repeat(64), 3)).toBe(true);
    const events = await repos.listWebhookEvents(10);
    expect(events.map((e) => e.eventType)).toEqual(['invoice.pago']);
  });

  it('escolher de novo devolve o mesmo valor', async () => {
    const inv = await liveInvoice();
    const a = await invoices.chooseUsdc(inv.id);
    const b = await invoices.chooseUsdc(inv.id);
    expect(b).toEqual(a);
  });

  it('pagamento depois do vencimento ainda vira pago (o USDC ja esta com a loja)', async () => {
    const inv = await liveInvoice();
    const payment = (await invoices.chooseUsdc(inv.id)) as { amount_usdc: string };
    now = new Date(now.getTime() + 2 * 3_600_000);
    await invoices.runSyncCycle(10);
    expect((await invoices.findPublic(inv.id))!.status).toBe('expirado');
    chain.logs.push({ transactionHash: '0x' + 'c'.repeat(64), logIndex: 1, value: BigInt(payment.amount_usdc.replace('.', '')), blockNumber: 1_100n });
    chain.height = 1_200n;
    await invoices.runSyncCycle(10);
    expect((await invoices.findPublic(inv.id))!).toMatchObject({ status: 'pago', paidRail: 'usdc' });
  });

  it('em dolar, o valor vai direto', async () => {
    const { client } = await createTestClient(repos, config);
    await db.db.execute(
      `insert into merchant_wallets (merchant_id, kind, purpose, chain, network, address, status, is_default)
       values ('${client.id}', 'usdc_settlement', 'loja', 'polygon', 'polygon', '${WALLET}', 'ativo', true)` as never,
    );
    const { invoice } = await invoices.create(client, null, 'live', { priceAmount: '12.34', priceCurrency: 'USD', orderId: 'd1' });
    const payment = (await invoices.chooseUsdc(invoice.id)) as { amount_usdc: string };
    expect(payment.amount_usdc).toMatch(/^12\.34\d{4}$/);
  });
});
