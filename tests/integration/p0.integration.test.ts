import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createRepositories } from '../../src/adapters/db/repositories.js';
import { createLockClient } from '../../src/adapters/db/client.js';
import {
  createTestDb,
  testDatabaseUrl,
  truncateAll,
} from './helpers.js';

/**
 * Regressao P0 contra Postgres REAL.
 *
 * Os fakes comparam tudo em lowercase e devolvem bigint; o driver
 * `postgres.js` devolve `numeric`/`bigint` como string. Estes testes cobrem
 * exatamente as diferencas que a suite em memoria nao enxerga.
 */

const db = createTestDb();
const repos = createRepositories(db.db);

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const COLD = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x37566338ADFbf56aa41FE8FC38aA92dB1e12aD59';

async function seedBase() {
  const clienteId = randomUUID();
  await repos.customers.create({
    id: clienteId,
    nomeEnc: Buffer.from('nome'),
    emailEnc: Buffer.from('email'),
    emailBidx: createHash('sha256').update(randomUUID()).digest('hex'),
    emailBidxV2: null,
    nomeMasked: 'N***',
    emailMasked: 'e***@e***.com',
    status: 'ativo',
    prefixBidxList: [],
    prefixBidxListV2: [],
  });

  const profile = await repos.rampProfiles.create({
    label: `Polygon ${randomUUID()}`,
    chain: 'polygon',
    asset: 'USDC',
    tokenContract: USDC,
    decimals: 6,
    fiatCurrency: 'BRL',
    baseUrl: 'https://buy.ramp.network/',
    paramStyle: 'legacy',
    hostAppName: 'Motor',
    hostApiKey: null,
    rampAssetKey: 'POLYGON_USDC',
    taxaTokenPorFiatBaseUnits: 180_000n,
  });

  await repos.coldWallets.create({ label: 'Fria', address: COLD, chain: 'polygon' });

  return { clienteId, profile };
}

async function createLink(clienteId: string, rampProfileId: string) {
  const index = await repos.indices.allocate('hd');
  return repos.links.create({
    clienteId,
    rampProfileId,
    chain: 'polygon',
    asset: 'USDC',
    tokenContract: USDC,
    decimals: 6,
    moedaFiat: 'BRL',
    valorFiatCentavos: 10_000,
    valorFiatUnidades: 10_000,
    taxaTokenPorFiatBaseUnits: 180_000n,
    expectedBaseUnits: 18_000_000n,
    indiceHd: index,
    caminhoDerivacao: `m/44'/60'/0'/0/${index}`,
    enderecoDeposito: DEPOSIT,
    carteiraFriaId: null,
    carteiraFriaEndereco: COLD,
    rampUrl: 'https://buy.ramp.network/?userAddress=deposit',
    status: 'aguardando',
    expiraEm: new Date(Date.now() + 3_600_000),
  });
}

async function addPayment(linkId: string, valorBaseUnits: bigint, logIndex = 0) {
  return repos.payments.upsert({
    linkId,
    txHash: `0x${createHash('sha256').update(randomUUID()).digest('hex')}`,
    logIndex,
    deAddress: '0x2222222222222222222222222222222222222222',
    paraAddress: DEPOSIT,
    token: 'USDC',
    valorBaseUnits,
    bloco: 100,
    status: 'detectado',
    detectadoEm: new Date(),
  });
}

describe('P0 com Postgres real', () => {
  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('converte sum/count em bigint/number (driver devolve string)', async () => {
    const { clienteId, profile } = await seedBase();
    const link = await createLink(clienteId, profile.id);
    const p = await addPayment(link.id, 1_000_000n);

    await repos.payments.confirm({
      paymentId: p.id,
      confirmacoes: 10,
      credit: null,
    });

    const total = await repos.payments.sumConfirmedByLink(link.id);
    expect(typeof total).toBe('bigint');
    expect(total).toBe(1_000_000n);

    const n = await repos.customers.count();
    expect(typeof n).toBe('number');
    expect(n).toBe(1);
  });

  it('armazena endereco lowercase e encontra por checksum', async () => {
    const { clienteId, profile } = await seedBase();
    const link = await createLink(clienteId, profile.id);

    const [row] = await db.sql<{ endereco_deposito: string }[]>`
      select endereco_deposito from links_gerados where id = ${link.id}
    `;
    expect(row?.endereco_deposito).toBe(DEPOSIT.toLowerCase());

    const porChecksum = await repos.links.findByDepositAddress(DEPOSIT);
    expect(porChecksum?.id).toBe(link.id);

    const porMinusculo = await repos.links.findByDepositAddress(DEPOSIT.toLowerCase());
    expect(porMinusculo?.id).toBe(link.id);
  });

  it('aloca indice HD global e respeita o limite', async () => {
    const a = await repos.indices.allocate('hd', 10);
    const b = await repos.indices.allocate('hd', 10);
    expect([a, b]).toEqual([0, 1]);

    await expect(repos.indices.allocate('hd', 1)).rejects.toThrow(/limite de indices HD/);
  });

  it('confirma pagamento e cria credito na mesma transacao (idempotente)', async () => {
    const { clienteId, profile } = await seedBase();
    const link = await createLink(clienteId, profile.id);
    const payment = await addPayment(link.id, 2_000_000n, 7);

    const credit = {
      clienteId,
      linkId: link.id,
      pagamentoId: payment.id,
      valorBaseUnits: 2_000_000n,
      valorCentavos: 1111,
      moeda: 'USDC',
      status: 'liberado' as const,
    };

    const first = await repos.payments.confirm({
      paymentId: payment.id,
      confirmacoes: 12,
      credit,
    });
    expect(first.creditCreated).toBe(true);
    expect((await repos.payments.findByTxHash(payment.txHash))?.status).toBe('confirmado');
    expect(await repos.credits.findByPayment(payment.id)).not.toBeNull();

    const second = await repos.payments.confirm({
      paymentId: payment.id,
      confirmacoes: 13,
      credit,
    });
    expect(second.creditCreated).toBe(false);
  });

  it('lista confirmados sem credito para recuperacao de crash', async () => {
    const { clienteId, profile } = await seedBase();
    const link = await createLink(clienteId, profile.id);
    const payment = await addPayment(link.id, 3_000_000n, 9);

    await repos.payments.confirm({
      paymentId: payment.id,
      confirmacoes: 10,
      credit: null,
    });
    // O monitor normalmente grava o status do link depois de confirmar.
    await repos.links.updateStatus(link.id, 'parcial');

    const pendentes = await repos.payments.listForReconciliation(10);
    expect(pendentes.map((p) => p.id)).toContain(payment.id);

    await repos.credits.create({
      clienteId,
      linkId: link.id,
      pagamentoId: payment.id,
      valorBaseUnits: 3_000_000n,
      valorCentavos: 0,
      moeda: 'USDC',
      status: 'liberado',
    });

    const depois = await repos.payments.listForReconciliation(10);
    expect(depois.map((p) => p.id)).not.toContain(payment.id);
  });

  it('lock de sessao usa conexao dedicada e libera ao fechar', async () => {
    const url = testDatabaseUrl();
    const lockId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
    const first = createLockClient(url, false);
    const second = createLockClient(url, false);

    try {
      const a = await first`select pg_try_advisory_lock(${lockId}) as ok`;
      expect(a[0]?.ok).toBe(true);

      const b = await second`select pg_try_advisory_lock(${lockId}) as ok`;
      expect(b[0]?.ok).toBe(false);

      await first`select pg_advisory_unlock(${lockId})`;
      const c = await second`select pg_try_advisory_lock(${lockId}) as ok`;
      expect(c[0]?.ok).toBe(true);
      await second`select pg_advisory_unlock(${lockId})`;
    } finally {
      await first.end({ timeout: 5 });
      await second.end({ timeout: 5 });
    }
  });
});
