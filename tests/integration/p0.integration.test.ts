import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalAuditPreimage } from '../../src/core/audit-preimage.js';
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
    emailBidxAnterior: null,
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

  it('atualiza a taxa do perfil sem tocar nos campos imutaveis', async () => {
    const { profile } = await seedBase();
    const updated = await repos.rampProfiles.update(profile.id, {
      taxaTokenPorFiatBaseUnits: 250_000n,
      label: 'Polygon USDC (nova)',
    });
    expect(updated?.taxaTokenPorFiatBaseUnits).toBe(250_000n);
    expect(updated?.label).toBe('Polygon USDC (nova)');
    expect(updated?.tokenContract.toLowerCase()).toBe(USDC.toLowerCase());
    expect(updated?.chain).toBe('polygon');

    const noop = await repos.rampProfiles.update(profile.id, {});
    expect(noop?.taxaTokenPorFiatBaseUnits).toBe(250_000n);

    const missing = await repos.rampProfiles.update(randomUUID(), { label: 'x' });
    expect(missing).toBeNull();
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

  it('libera indice HD reservado e nunca reutiliza indice com link', async () => {
    const a = await repos.indices.allocate('hd', 10);
    await repos.indices.release('hd', a);
    const b = await repos.indices.allocate('hd', 10);
    expect(b).toBe(a);

    const { clienteId, profile } = await seedBase();
    const link = await createLink(clienteId, profile.id);
    await repos.indices.release('hd', link.indiceHd);

    const c = await repos.indices.allocate('hd', 10);
    expect(c).toBe(link.indiceHd + 1);
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
      valorCentavos: 1111n,
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

  it('re-detecta no novo bloco e restaura credito revertido por reorg', async () => {
    const { clienteId, profile } = await seedBase();
    const link = await createLink(clienteId, profile.id);
    const payment = await addPayment(link.id, 4_000_000n, 3);
    const credit = {
      clienteId,
      linkId: link.id,
      pagamentoId: payment.id,
      valorBaseUnits: payment.valorBaseUnits,
      valorCentavos: 500n,
      moeda: 'USDC',
      status: 'liberado' as const,
    };

    await repos.payments.confirm({
      paymentId: payment.id,
      confirmacoes: 10,
      credit,
    });
    await repos.payments.revertAboveBlock('polygon', 99);
    await repos.credits.revertByPaymentIds([payment.id]);
    expect((await repos.credits.findByPayment(payment.id))?.status).toBe('revertido');

    const reencontrado = await repos.payments.upsert({
      linkId: link.id,
      txHash: payment.txHash,
      logIndex: payment.logIndex,
      deAddress: payment.deAddress,
      paraAddress: payment.paraAddress,
      token: payment.token,
      valorBaseUnits: payment.valorBaseUnits,
      bloco: 105,
      status: 'detectado',
      detectadoEm: new Date(),
    });
    expect(reencontrado.bloco).toBe(105);
    expect(reencontrado.status).toBe('detectado');
    expect(reencontrado.confirmacoes).toBe(0);
    expect(reencontrado.confirmadoEm).toBeNull();

    await repos.payments.confirm({
      paymentId: payment.id,
      confirmacoes: 10,
      credit,
    });
    expect((await repos.payments.findByTxHash(payment.txHash))?.status).toBe('confirmado');
    expect((await repos.credits.findByPayment(payment.id))?.status).toBe('liberado');
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
      valorCentavos: 0n,
      moeda: 'USDC',
      status: 'liberado',
    });

    const depois = await repos.payments.listForReconciliation(10);
    expect(depois.map((p) => p.id)).not.toContain(payment.id);
  });

  it('persiste kind/raw e permite sweep e dust no mesmo nonce', async () => {
    const { clienteId, profile } = await seedBase();
    const link = await createLink(clienteId, profile.id);
    const txHash = `0x${'ab'.repeat(32)}`;
    const raw = `0x${'cd'.repeat(100)}`;

    const sweep = await repos.transfers.create({
      linkId: link.id,
      deAddress: DEPOSIT,
      paraAddress: COLD,
      valorBaseUnits: 10_000_000n,
      status: 'pendente',
      chain: 'polygon',
      nonce: 0,
      kind: 'sweep',
      txHash,
      rawTransaction: raw,
    });
    expect(sweep.kind).toBe('sweep');
    expect(sweep.rawTransaction).toBe(raw);

    const dust = await repos.transfers.create({
      linkId: link.id,
      deAddress: DEPOSIT,
      paraAddress: COLD,
      valorBaseUnits: 1n,
      status: 'pendente',
      chain: 'polygon',
      nonce: 0,
      kind: 'dust',
      txHash,
      rawTransaction: raw,
    });
    expect(dust.kind).toBe('dust');

    const encontrado = await repos.transfers.findByLinkKindNonce(link.id, 'sweep', 0);
    expect(encontrado?.id).toBe(sweep.id);

    await expect(
      repos.transfers.create({
        linkId: link.id,
        deAddress: DEPOSIT,
        paraAddress: COLD,
        valorBaseUnits: 1n,
        status: 'pendente',
        chain: 'polygon',
        nonce: 0,
        kind: 'sweep',
        txHash,
        rawTransaction: raw,
      }),
    ).rejects.toThrow();
  });

  it('nao perde prefixo compartilhado e mantem email canonico unico', async () => {
    const prefixo = createHash('sha256').update('prefixo:mar').digest('hex');
    const emailA = createHash('sha256').update('maria@example.com').digest('hex');
    const emailB = createHash('sha256').update('marcos@example.com').digest('hex');

    const base = (id: string, emailBidx: string) => ({
      id,
      nomeEnc: Buffer.from('nome'),
      emailEnc: Buffer.from('email'),
      emailBidx,
      emailBidxAnterior: null,
      nomeMasked: 'M***',
      emailMasked: 'm***@e***.com',
      status: 'ativo' as const,
      prefixBidxList: [prefixo],
      prefixBidxListV2: [],
    });

    // PK composta (cliente_id, prefix_bidx): o mesmo token pode existir
    // para clientes diferentes sem o segundo ser descartado.
    await repos.customers.create(base(randomUUID(), emailA));
    await repos.customers.create(base(randomUUID(), emailB));

    const achados = await repos.customers.searchByEmailPrefixBidx([prefixo], 10);
    expect(achados).toHaveLength(2);

    // O unique canonico continua valendo para a coluna ativa.
    const erro = await repos.customers
      .create(base(randomUUID(), emailA))
      .catch((e: unknown) => e);
    const code =
      (erro as { code?: string; cause?: { code?: string } }).code ??
      (erro as { cause?: { code?: string } }).cause?.code;
    expect(code).toBe('23505');
  });

  it('hash de auditoria cobre id, criadoEm e ip encadeados', async () => {
    await repos.audit.record({
      ator: 'api',
      acao: 'teste.um',
      entidade: 'teste',
      entidadeId: randomUUID(),
      ip: '203.0.113.10',
      detalhes: { n: 1 },
    });
    await repos.audit.record({
      ator: 'api',
      acao: 'teste.dois',
      entidade: 'teste',
      ip: '203.0.113.11',
      detalhes: { n: 2 },
    });

    type AuditRow = {
      id: string;
      ator: string;
      acao: string;
      entidade: string;
      entidade_id: string | null;
      detalhes: string | null;
      ip: string | null;
      hash_anterior: string | null;
      hash: string;
      criado_em: Date | string;
    };
    const rows = await db.sql<AuditRow[]>`
      select id, ator, acao, entidade, entidade_id, detalhes, ip,
             hash_anterior, hash, criado_em
      from eventos_auditoria
      order by criado_em asc, id asc
    `;
    expect(rows).toHaveLength(2);

    let anterior: string | null = null;
    for (const row of rows) {
      const criadoEm =
        row.criado_em instanceof Date ? row.criado_em : new Date(row.criado_em);
      const esperado = createHash('sha256')
        .update(
          canonicalAuditPreimage([
            row.hash_anterior ?? '',
            row.id,
            criadoEm.toISOString(),
            row.ator,
            row.acao,
            row.entidade,
            row.entidade_id ?? '',
            row.ip ?? '',
            row.detalhes ?? '',
          ]),
        )
        .digest('hex');
      expect(row.hash).toBe(esperado);
      expect(row.hash_anterior).toBe(anterior);
      anterior = row.hash;
    }
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
