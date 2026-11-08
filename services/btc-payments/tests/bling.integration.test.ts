import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { blingConnections, blingExports, invoices as invoicesTable } from '../src/db/schema.js';
import { silentLogger } from '../src/logger.js';
import { BlingService, blingDate } from '../src/services/bling-service.js';
import { InvoiceService } from '../src/services/invoice-service.js';
import { createTestClient, testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

type Call = { url: string; method: string; body: string | undefined; auth: string | undefined };

function fakeBling() {
  const calls: Call[] = [];
  let tokens = 0;
  let nextConta = 900;
  const state = { failCreate: false, expiresIn: 21_600 };
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body, auth: init.headers.authorization });
    const reply = (status: number, data: unknown) => ({ status, json: async () => data });
    if (url.endsWith('/oauth/token')) {
      tokens += 1;
      return reply(200, { access_token: `acc-${tokens}`, refresh_token: `ref-${tokens}`, expires_in: state.expiresIn, token_type: 'Bearer' });
    }
    if (url.endsWith('/contatos/consumidor-final')) return reply(200, { data: { id: 555, nome: 'Consumidor Final' } });
    if (url.endsWith('/contas/receber') && init.method === 'POST') {
      if (state.failCreate) return reply(400, { error: { type: 'VALIDATION_ERROR', fields: [{ msg: 'categoria invalida' }] } });
      return reply(201, { data: { id: nextConta++ } });
    }
    if (/\/contas\/receber\/\d+\/baixar$/.test(url)) return reply(200, {});
    if (url.includes('/contas-contabeis')) return reply(200, { data: [{ id: 11, descricao: 'Conta Inter' }] });
    if (url.includes('/categorias/receitas-despesas')) return reply(200, { data: [{ id: 22, descricao: 'Vendas online' }] });
    return reply(404, {});
  };
  return { calls, fetchImpl, state };
}

maybeDescribe('Bling: vendas pagas viram contas a receber (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let api: ReturnType<typeof fakeBling>;
  let bling: BlingService;
  let invoices: InvoiceService;
  let now: Date;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({ BLING_CLIENT_ID: 'bling-client', BLING_CLIENT_SECRET: 'bling-secret-123' });
    api = fakeBling();
    now = new Date();
    bling = new BlingService({ db: db.db, repos, config, logger: silentLogger, fetchImpl: api.fetchImpl as never, pauseMs: 0, now: () => now });
    invoices = new InvoiceService({ db: db.db, repos, config, logger: silentLogger });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function connected() {
    const { client } = await createTestClient(repos, config);
    await db.db.execute(
      `insert into merchant_wallets (merchant_id, kind, purpose, chain, network, address, status, is_default)
       values ('${client.id}', 'usdc_settlement', 'loja', 'polygon', 'polygon', '0x4cd01696cd0165d6020ab7d8ae866fdf2fed3855', 'ativo', true)` as never,
    );
    const state = new URL(bling.authorizeUrl(client.id)).searchParams.get('state')!;
    await bling.completeInstall('code-1', state);
    return client;
  }

  async function paidInvoice(clientId: string, orderId: string, price = '149.70', currency: 'BRL' | 'USD' = 'BRL') {
    const client = (await repos.findClientById(clientId))!;
    const { invoice } = await invoices.create(client, null, 'live', { priceAmount: price, priceCurrency: currency, orderId });
    await db.db
      .update(invoicesTable)
      .set({ status: 'pago', paidRail: 'pix_direto', txHash: 'E777', paidAt: new Date(now.getTime() + 1000) })
      .where(eq(invoicesTable.id, invoice.id));
    return invoice.id;
  }

  it('conecta com o code, guarda o token cifrado; state adulterado falha', async () => {
    const client = await connected();
    const tokenCall = api.calls[0]!;
    expect(tokenCall.auth).toBe(`Basic ${Buffer.from('bling-client:bling-secret-123').toString('base64')}`);
    expect(tokenCall.body).toBe('grant_type=authorization_code&code=code-1');
    const [conn] = await db.db.select().from(blingConnections);
    expect(conn!.clientId).toBe(client.id);
    expect(conn!.accessTokenEnc).not.toContain('acc-1');
    await expect(bling.completeInstall('x', 'abc.def')).rejects.toThrow(/state/);
  });

  it('lanca a venda paga uma vez, no Consumidor Final, e da baixa com conta e categoria', async () => {
    const client = await connected();
    expect(await bling.options(client.id)).toEqual({ portadores: [{ id: '11', descricao: 'Conta Inter' }], categorias: [{ id: '22', descricao: 'Vendas online' }] });
    await bling.setSettings(client.id, { portadorId: '11', categoriaId: '22' });
    const id = await paidInvoice(client.id, 'woo-123');
    await paidInvoice(client.id, 'em-dolar', '10.00', 'USD');

    const result = await bling.runExportCycle();
    expect(result).toEqual({ checked: 1, exported: 1 });
    const create = api.calls.find((c) => c.url.endsWith('/contas/receber'))!;
    expect(create.auth).toBe('Bearer acc-1');
    expect(JSON.parse(create.body!)).toMatchObject({
      vencimento: blingDate(new Date(now.getTime() + 1000)),
      valor: 149.7,
      contato: { id: 555 },
      numeroDocumento: 'woo-123',
      categoria: { id: 22 },
      portador: { id: 11 },
    });
    expect(JSON.parse(create.body!).historico).toContain('Pix');
    const baixa = api.calls.find((c) => c.url.endsWith('/contas/receber/900/baixar'))!;
    expect(JSON.parse(baixa.body!)).toMatchObject({ usarDataVencimento: false, valorRecebido: 149.7, portador: { id: 11 }, categoria: { id: 22 } });
    const [exp] = await db.db.select().from(blingExports).where(eq(blingExports.invoiceId, id));
    expect(exp).toMatchObject({ contaId: 900n, settled: true });

    expect(await bling.runExportCycle()).toEqual({ checked: 0, exported: 0 });
  });

  it('renova o token vencido antes de chamar a API', async () => {
    api.state.expiresIn = 60;
    const client = await connected();
    api.state.expiresIn = 21_600;
    await paidInvoice(client.id, 'p1');
    await paidInvoice(client.id, 'p1b');
    expect((await bling.runExportCycle()).exported).toBe(2);
    // Duas vendas no mesmo ciclo: uma renovacao so.
    const tokenCalls = api.calls.filter((c) => c.url.endsWith('/oauth/token'));
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[1]!.body).toBe('grant_type=refresh_token&refresh_token=ref-1');
    expect(api.calls.find((c) => c.url.endsWith('/contas/receber'))!.auth).toBe('Bearer acc-2');
  });

  it('erro do Bling fica visivel e tenta de novo depois; sem baixa sem conta/categoria', async () => {
    const client = await connected();
    const id = await paidInvoice(client.id, 'p2');
    api.state.failCreate = true;
    await bling.runExportCycle();
    const status = await bling.status(client.id);
    expect(status).toMatchObject({ connected: true, last_error: expect.stringMatching(/categoria invalida/) });
    api.state.failCreate = false;
    await bling.runExportCycle();
    const [exp] = await db.db.select().from(blingExports).where(eq(blingExports.invoiceId, id));
    expect(exp).toMatchObject({ settled: false, error: null });
    expect(exp!.contaId).not.toBeNull();
    expect(api.calls.some((c) => c.url.includes('/baixar'))).toBe(false);
  });

  it('venda paga antes de conectar nao e lancada (fica no CSV)', async () => {
    const { client } = await createTestClient(repos, config);
    await db.db.execute(
      `insert into merchant_wallets (merchant_id, kind, purpose, chain, network, address, status, is_default)
       values ('${client.id}', 'usdc_settlement', 'loja', 'polygon', 'polygon', '0x4cd01696cd0165d6020ab7d8ae866fdf2fed3855', 'ativo', true)` as never,
    );
    await paidInvoice(client.id, 'antigo');
    now = new Date(now.getTime() + 60_000);
    const state = new URL(bling.authorizeUrl(client.id)).searchParams.get('state')!;
    await bling.completeInstall('code-2', state);
    expect(await bling.runExportCycle()).toEqual({ checked: 0, exported: 0 });
  });
});
