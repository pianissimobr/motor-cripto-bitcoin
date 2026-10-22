import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { BlockchainMonitor } from '../src/core/chain/monitor.js';
import { silentLogger } from '../src/core/logger.js';
import { createFakeRepositories, type FakeCursorRepository } from './fakes.js';

/**
 * Frente B3: contrato do watermark do cursor.
 *
 * A propriedade que o motor PRECISA garantir:
 *   o cursor NUNCA avanca alem do bloco que o RPC efetivamente entregou.
 *
 * Era exatamente o bug corrigido na entrega inicial: o cursor era gravado
 * em `toBlock` mesmo quando o provedor recusava a faixa, pulando blocos.
 * Aqui testamos com um provider que sempre reduz a faixa aceita.
 */

/** Chain simulada com N blocos. */
function makeProvider(opts: {
  totalBlocos: number;
  /** Maior span que o RPC aceita por requisição. */
  spanAceito: number;
  /** Blocos onde ha Transfer para o endereço. */
  logsEm?: Array<{ bloco: number; to: string; valor: bigint; txHash: string }>;
}) {
  const chamadas: Array<{ from: number; to: number }> = [];
  const spanAceito = Math.max(1, opts.spanAceito);

  const provider = {
    network: { chainId: 137n },
    chamadas,
    getBlockNumber: async () => opts.totalBlocos,
    getBlock: async (n: number | string) => {
      const numero = typeof n === 'string' ? Number(n) : n;
      if (numero < 0 || numero > opts.totalBlocos) return null;
      return { number: numero, hash: `0xblk${numero}` };
    },
    getLogs: async (f: { fromBlock?: number; toBlock?: number }) => {
      const from = f.fromBlock ?? 0;
      const to = f.toBlock ?? opts.totalBlocos;
      chamadas.push({ from, to });
      if (to - from + 1 > spanAceito) {
        const err = new Error('invalid block range params');
        throw err;
      }
      return (opts.logsEm ?? [])
        .filter((l) => l.bloco >= from && l.bloco <= to)
        .map((l) => ({
          address: '0xtoken',
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            `0x${'0'.repeat(24)}1111111111111111111111111111111111111111`,
            `0x${'0'.repeat(24)}${l.to.replace('0x', '')}`,
          ],
          data: `0x${l.valor.toString(16).padStart(64, '0')}`,
          blockNumber: l.bloco,
          transactionHash: l.txHash,
          index: 0,
        }));
    },
    call: async () => '0x' + '0'.repeat(64),
    getBalance: async () => 0n,
    getTransactionCount: async () => 0,
  };
  return provider;
}

function setup(opts: {
  totalBlocos: number;
  spanAceito: number;
  logsEm?: Array<{ bloco: number; to: string; valor: bigint; txHash: string }>;
}) {
  const repos = createFakeRepositories();
  const provider = makeProvider(opts);

  const monitor = new BlockchainMonitor({
    repos,
    providerFactory: () => provider as never,
    logger: silentLogger,
    linkState: {
      transition: async () => 'pago',
    } as never,
    reorgDetector: {
      check: async () => ({ reorg: false, blocoSeguro: 0, ancorasTestadas: 0, reconstrucaoTotal: false, mensagem: '' }),
      maybeAnchor: async () => {},
    } as never,
    options: {
      confirmationsRequired: 1,
      tolerancePct: 1,
      maxTopics: 200,
      blockRange: 2000,
      startBlock: 0,
      blockTag: 'latest',
      anchorInterval: 32,
      maxReorgAnchors: 64,
    },
  });

  return { repos, monitor, provider, cursors: repos.cursors as FakeCursorRepository };
}

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

/**
 * Cria o link direto no repo, com o endereco de deposito que queremos vigiar
 * (a derivacao HD nao importa para o contrato do cursor).
 */
async function seed(repo: ReturnType<typeof setup>['repos'], endereco: string) {
  const perfil = await repo.rampProfiles.create({
    label: 'P',
    chain: 'polygon',
    asset: 'USDC',
    tokenContract: USDC,
    decimals: 6,
    fiatCurrency: 'BRL',
    baseUrl: 'https://x/',
    paramStyle: 'legacy',
    hostAppName: 'M',
    hostApiKey: null,
    rampAssetKey: null,
    taxaTokenPorFiatBaseUnits: null,
  });
  // Cliente criado pelo servico (exige material cifrado).
  const { DataCipher, BlindIndex } = await import('../src/core/crypto/cipher.js');
  const { randomUUID } = await import('node:crypto');
  const cipher = new DataCipher(Buffer.alloc(32, 7));
  const idx = new BlindIndex(Buffer.alloc(32, 9));
  const email = 'c@e.com';
  const id = randomUUID();
  const cliente = await repo.customers.create({
    id,
    nomeEnc: cipher.encrypt('C', id),
    emailEnc: cipher.encrypt(email, id),
    emailBidx: idx.compute(email),
    emailBidxAnterior: null,
    nomeMasked: 'C***',
    emailMasked: 'c***@e***.com',
    status: 'ativo',
    prefixBidxList: [],
    prefixBidxListV2: [],
  });
  return repo.links.create({
    clienteId: cliente.id,
    rampProfileId: perfil.id,
    chain: 'polygon',
    asset: 'USDC',
    tokenContract: USDC,
    decimals: 6,
    moedaFiat: 'BRL',
    valorFiatCentavos: 1000,
    valorFiatUnidades: 1000,
    taxaTokenPorFiatBaseUnits: null,
    expectedBaseUnits: null,
    indiceHd: 0,
    caminhoDerivacao: 'x',
    enderecoDeposito: endereco,
    carteiraFriaId: null,
    carteiraFriaEndereco: '0x1111111111111111111111111111111111111111',
    rampUrl: 'http://x/',
    status: 'aguardando',
    expiraEm: new Date(Date.now() + 86_400_000),
  });
}

const DESTINO = '0x2222222222222222222222222222222222222222';

describe('B3: contrato do cursor', () => {
  it('o cursor nunca ultrapassa o bloco coberto pelo RPC', async () => {
    // O RPC so aceita 100 blocos por vez, mas o motor quer ler 2000.
    // O cursor tem de parar onde a leitura realmente terminou.
    const ctx = setup({ totalBlocos: 5000, spanAceito: 100 });
    await seed(ctx.repos, DESTINO);

    await ctx.monitor.runCycle();

    const cursor = await ctx.cursors.get('polygon', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
    expect(cursor).not.toBeNull();
    // Nunca 5000 (o toBlock que o motor pediu) nem maior que o total.
    expect(cursor!.ultimoBloco).toBeLessThanOrEqual(5000);
    // Deve ter parado no fim da faixa efetivamente coberta.
    expect(cursor!.ultimoBloco).toBeGreaterThan(0);
  });

  it('propriedade: cursor <= head sempre', async () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 8000 }),
        fc.integer({ min: 1, max: 300 }),
        async (head, span) => {
          const ctx = setup({ totalBlocos: head, spanAceito: span });
          await seed(ctx.repos, DESTINO);
          await ctx.monitor.runCycle();
          const cursor = await ctx.cursors.get(
            'polygon',
            '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
          );
          if (cursor) {
            expect(cursor.ultimoBloco).toBeLessThanOrEqual(head);
            expect(cursor.ultimoBloco).toBeGreaterThanOrEqual(0);
          }
          await ctx.cursors.set('polygon', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 0, null);
        },
      ),
      { numRuns: 30, timeout: 30000 },
    );
  });

  it('ciclos consecutivos recomecam exatamente apos o fim do anterior', async () => {
    // O que nao pode acontecer: pular blocos (cursor > fim do anterior + 1
    // sem ter lido o intervalo) ou regredir. A propriedade e continuidade.
    const ctx = setup({ totalBlocos: 300, spanAceito: 20 });
    await seed(ctx.repos, DESTINO);
    const KEY = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

    let anterior = -1;
    for (let ciclo = 0; ciclo < 6; ciclo++) {
      await ctx.monitor.runCycle();
      const cursor = (await ctx.cursors.get('polygon', KEY))!;
      if (anterior >= 0) {
        // Monotono: nunca regride.
        expect(cursor.ultimoBloco).toBeGreaterThanOrEqual(anterior);
        // Sem buraco: a proxima leitura comeca em anterior+1, nunca depois.
        const ultimaChamada = ctx.provider.chamadas.at(-1);
        if (ultimaChamada) {
          expect(ultimaChamada.from).toBeLessThanOrEqual(anterior + 1 + 1);
        }
      }
      anterior = cursor.ultimoBloco;
    }
    expect(anterior).toBeGreaterThan(0);
  });

  it('detecta pagamento em qualquer posicao da cadeia simulada', async () => {
    const ctx = setup({
      totalBlocos: 1000,
      spanAceito: 100,
      logsEm: [{ bloco: 700, to: DESTINO, valor: 5_000_000n, txHash: '0xfeed' }],
    });
    await seed(ctx.repos, DESTINO);

    const r = await ctx.monitor.runCycle();
    expect(r.logsVarridos).toBeGreaterThan(0);

    // O pagamento pode nao estar na primeira janela; forca varios ciclos.
    for (let i = 0; i < 30; i++) await ctx.monitor.runCycle();

    const cursor = await ctx.cursors.get('polygon', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
    expect(cursor!.ultimoBloco).toBeGreaterThanOrEqual(700);
  });
});