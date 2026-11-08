import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { PixApiConfig, PixCob } from '../src/adapters/pix-api/client.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { silentLogger } from '../src/logger.js';
import { InvoiceService } from '../src/services/invoice-service.js';
import { PixDiretoService } from '../src/services/pix-direto-service.js';
import { createTestClient, testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;
const P12 = Buffer.alloc(600, 7).toString('base64');

/** Banco falso: guarda as cobrancas e deixa o teste marcar como pagas. */
class FakeBank {
  cobs = new Map<string, PixCob>();
  configs: PixApiConfig[] = [];
  failCheck = false;
  factory = (config: PixApiConfig) => {
    this.configs.push(config);
    return {
      check: async () => {
        if (this.failCheck) throw new Error('certificado recusado ou invalido (token)');
      },
      createCob: async (input: { txid: string; amountCents: bigint }) => {
        const existing = this.cobs.get(input.txid);
        if (existing) return existing;
        const cob: PixCob = { txid: input.txid, status: 'ATIVA', pixCopiaECola: `PIX-${input.txid}`, amountCents: input.amountCents, payments: [] };
        this.cobs.set(input.txid, cob);
        return cob;
      },
      getCob: async (txid: string) => this.cobs.get(txid)!,
    };
  };
  pay(txid: string, cents: bigint) {
    const cob = this.cobs.get(txid)!;
    this.cobs.set(txid, { ...cob, status: 'CONCLUIDA', payments: [{ endToEndId: `E${txid.slice(0, 10)}`, amountCents: cents }] });
  }
}

maybeDescribe('Pix direto pela API do banco da loja (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let bank: FakeBank;
  let pixDireto: PixDiretoService;
  let invoices: InvoiceService;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig();
    bank = new FakeBank();
    pixDireto = new PixDiretoService({ db: db.db, repos, config, logger: silentLogger, clientFactory: bank.factory });
    invoices = new InvoiceService({ db: db.db, repos, config, logger: silentLogger, pixDireto });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function merchant() {
    const { client } = await createTestClient(repos, config);
    await db.db.execute(
      `insert into merchant_wallets (merchant_id, kind, purpose, chain, network, address, status, is_default)
       values ('${client.id}', 'usdc_settlement', 'loja', 'polygon', 'polygon', '0x4cd01696cd0165d6020ab7d8ae866fdf2fed3855', 'ativo', true)` as never,
    );
    return client;
  }

  const save = (clientId: string, extra: Record<string, unknown> = {}) =>
    pixDireto.save(
      clientId,
      { psp: 'efi', environment: 'producao', clientId: 'Client_Id_x', clientSecret: 'segredo', certificateP12Base64: P12, certificatePassphrase: '', pixKey: 'loja@exemplo.com', ...extra },
      'teste',
    );

  it('salva cifrado, testa a conexao e nao devolve segredo', async () => {
    const client = await merchant();
    const view = await save(client.id);
    expect(view).toMatchObject({ configured: true, psp: 'efi', enabled: true, last_check_error: null, pix_key: 'loja@exemplo.com' });
    expect(JSON.stringify(view)).not.toContain('segredo');
    const raw = await db.db.execute(`select oauth_client_secret_enc, certificate_enc from merchant_pix_banks` as never);
    expect(JSON.stringify(raw)).not.toContain('segredo');
    expect(bank.configs.at(-1)).toMatchObject({ clientSecret: 'segredo', certificateP12Base64: P12 });

    // Editar sem reenviar segredo e certificado mantem os atuais.
    await save(client.id, { clientSecret: undefined, certificateP12Base64: undefined, pixKey: 'outra@exemplo.com' });
    expect(bank.configs.at(-1)).toMatchObject({ clientSecret: 'segredo', certificateP12Base64: P12, pixKey: 'outra@exemplo.com' });
  });

  it('teste falhou: fica desligado e mostra o erro; a fatura nao oferece Pix direto', async () => {
    const client = await merchant();
    bank.failCheck = true;
    const view = await save(client.id);
    expect(view).toMatchObject({ enabled: false, last_check_error: expect.stringMatching(/certificado/) });
    const { invoice } = await invoices.create(client, null, 'live', { priceAmount: '10.00', priceCurrency: 'BRL', orderId: 'x' });
    expect(invoice.rails).not.toContain('pix_direto');
  });

  it('fatura com o banco ligado: Pix direto, sem CPF, confirma com o endToEndId', async () => {
    const client = await merchant();
    await save(client.id);
    const { invoice } = await invoices.create(client, null, 'live', { priceAmount: '149.70', priceCurrency: 'BRL', orderId: 'wc-11' });
    expect(invoice.rails[0]).toBe('pix_direto');
    expect(invoice.rails).not.toContain('pix');

    const payment = await invoices.choosePixDireto(invoice.id);
    const txid = invoice.id.replace(/-/g, '');
    expect(payment).toMatchObject({ rail: 'pix_direto', qr_copypaste: `PIX-${txid}` });
    // Escolher de novo nao cria outra cobranca.
    await invoices.choosePixDireto(invoice.id);
    expect(bank.cobs.size).toBe(1);

    let row = await invoices.sync((await invoices.findPublic(invoice.id))!);
    expect(row.status).toBe('aguardando');
    // Pagou menos: nao conta.
    bank.pay(txid, 14_900n);
    row = await invoices.sync(row);
    expect(row.status).toBe('aguardando');
    bank.pay(txid, 14_970n);
    row = await invoices.sync(row);
    expect(row).toMatchObject({ status: 'pago', paidRail: 'pix_direto', txHash: `E${txid.slice(0, 10)}` });
  });

  it('Pix direto so em real', async () => {
    const client = await merchant();
    await save(client.id);
    const { invoice } = await invoices.create(client, null, 'live', { priceAmount: '10.00', priceCurrency: 'USD', orderId: 'usd' });
    expect(invoice.rails).toEqual(['usdc']);
  });
});
