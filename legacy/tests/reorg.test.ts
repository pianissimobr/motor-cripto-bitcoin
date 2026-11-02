import { describe, expect, it } from 'vitest';

import { ReorgDetector, type BlockHashFetcher } from '../src/core/chain/reorg-detector.js';
import { silentLogger } from '../src/core/logger.js';
import {
  FakeAnchorRepository,
  FakeCursorRepository,
  type FakeAnchorRepository as AnchorRepo,
} from './fakes.js';

/**
 * Frente C - reorg.
 *
 * C2/C3: o detector compara o hash do bloco do cursor com a chain; se
 * divergir, volta ate o ancestral comum usando ancoras esparsas.
 * C6: chain simulada - sem RPC, so com um mapa de hash por bloco.
 */

const CHAIN = 'polygon';
const TOKEN = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

/** Chain simulada: mapa bloco -> hash. */
function fakeChain(initial: Record<number, string>) {
  const blocos = new Map<number, string>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  const fetcher: BlockHashFetcher = async (bloco) => blocos.get(bloco) ?? null;
  return {
    blocos,
    fetcher,
    /** Reescreve um bloco e tudo acima (simula o reorg). */
    reescrever(de: number, novoHash: string, quantos = 10) {
      for (let i = 0; i < quantos; i++) {
        blocos.set(de + i, `${novoHash.slice(0, -2)}${(de + i).toString(16).padStart(2, '0')}`);
      }
    },
  };
}

function setup() {
  const cursors = new FakeCursorRepository();
  const anchors = new FakeAnchorRepository();
  const detector = new ReorgDetector({
    cursors,
    anchors,
    logger: silentLogger,
    maxAnchors: 64,
  });
  return { cursors, anchors: anchors as AnchorRepo, detector };
}

describe('C2: ancoras esparsas', () => {
  it('grava ancora quando o cursor avanca o intervalo', async () => {
    const { detector, anchors } = setup();
    for (const bloco of [30, 31, 32, 33, 64]) {
      await detector.maybeAnchor(CHAIN, TOKEN, bloco, `0xhash${bloco}`, 32);
    }
    const guardadas = await anchors.list(CHAIN, TOKEN, 100);
    // Primeira ancora no 30; o salto de 30 -> 64 ja passou de 32.
    expect(guardadas.map((a) => a.bloco).sort((a, b) => a - b)).toEqual([30, 64]);
  });

  it('nao grava ancora sem hash', async () => {
    const { detector, anchors } = setup();
    await detector.maybeAnchor(CHAIN, TOKEN, 32, null, 32);
    expect(await anchors.list(CHAIN, TOKEN, 100)).toHaveLength(0);
  });

  it('nao duplica a mesma ancora', async () => {
    const { detector, anchors } = setup();
    await detector.maybeAnchor(CHAIN, TOKEN, 32, '0xaa', 32);
    await detector.maybeAnchor(CHAIN, TOKEN, 32, '0xbb', 32);
    const guardadas = await anchors.list(CHAIN, TOKEN, 100);
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]?.hashBloco).toBe('0xaa');
  });

  it('normaliza o contrato para minusculas', async () => {
    const { detector, anchors } = setup();
    await detector.maybeAnchor(CHAIN, TOKEN.toUpperCase(), 32, '0xaa', 32);
    const guardadas = await anchors.list(CHAIN, TOKEN.toLowerCase(), 100);
    expect(guardadas).toHaveLength(1);
  });
});

describe('C3: deteccao sem falso positivo', () => {
  it('nao acusa reorg quando o cursor confere', async () => {
    const { detector, cursors } = setup();
    const chain = fakeChain({ 100: '0xabc100', 101: '0xabc101', 102: '0xabc102' });
    await cursors.set(CHAIN, TOKEN, 102, '0xabc102');

    const r = await detector.checkWithFetcher(CHAIN, TOKEN, 102, '0xabc102', chain.fetcher);
    expect(r.reorg).toBe(false);
    expect(r.blocoSeguro).toBe(102);
  });

  it('nao acusa reorg quando o bloco ainda nao existe no RPC (lag)', async () => {
    const { detector, cursors } = setup();
    // O cursor aponta para um bloco que o provider ainda nao devolveu.
    const chain = fakeChain({ 100: '0xabc100' });
    await cursors.set(CHAIN, TOKEN, 105, '0xabc105');

    const r = await detector.checkWithFetcher(CHAIN, TOKEN, 105, '0xabc105', chain.fetcher);
    expect(r.reorg).toBe(false);
    expect(r.blocoSeguro).toBe(105);
  });

  it('nao faz nada sem cursor', async () => {
    const { detector } = setup();
    const chain = fakeChain({});
    const r = await detector.checkWithFetcher(CHAIN, TOKEN, 0, '', chain.fetcher);
    expect(r.reorg).toBe(false);
  });
});

describe('C3: deteccao de reorg com ancestral comum', () => {
  it('rebobina o cursor ate a ancora valida', async () => {
    const { detector, cursors, anchors } = setup();
    const chain = fakeChain({
      64: '0xa64', 96: '0xa96', 128: '0xa128', 200: '0xa200',
    });
    await anchors.record({ chain: CHAIN, tokenContract: TOKEN, bloco: 64, hashBloco: '0xa64' });
    await anchors.record({ chain: CHAIN, tokenContract: TOKEN, bloco: 96, hashBloco: '0xa96' });
    await anchors.record({ chain: CHAIN, tokenContract: TOKEN, bloco: 128, hashBloco: '0xa128' });
    await cursors.set(CHAIN, TOKEN, 200, '0xa200');

    // A chain reescreve a partir do bloco 150: o 200 agora tem outro hash,
    // mas 128 continua igual -> ancestral comum = 128.
    chain.blocos.set(200, '0xREESCRITO200');

    const r = await detector.checkWithFetcher(CHAIN, TOKEN, 200, '0xa200', chain.fetcher);
    expect(r.reorg).toBe(true);
    expect(r.blocoSeguro).toBe(128);
    expect(r.reconstrucaoTotal).toBe(false);

    // Cursor foi rebobinado de fato.
    const cursor = await cursors.get(CHAIN, TOKEN);
    expect(cursor?.ultimoBloco).toBe(128);
    expect(cursor?.hashBloco).toBe('0xa128');
  });

  it('descarta as ancoras invalidadas pelo reorg', async () => {
    const { detector, cursors, anchors } = setup();
    const chain = fakeChain({
      64: '0xa64', 96: '0xa96', 128: '0xa128', 200: '0xa200',
    });
    await anchors.record({ chain: CHAIN, tokenContract: TOKEN, bloco: 64, hashBloco: '0xa64' });
    await anchors.record({ chain: CHAIN, tokenContract: TOKEN, bloco: 96, hashBloco: '0xa96' });
    await anchors.record({ chain: CHAIN, tokenContract: TOKEN, bloco: 128, hashBloco: '0xa128' });
    await cursors.set(CHAIN, TOKEN, 200, '0xa200');
    chain.blocos.set(200, '0xNOVO200');

    await detector.checkWithFetcher(CHAIN, TOKEN, 200, '0xa200', chain.fetcher);

    const restantes = await anchors.list(CHAIN, TOKEN, 100);
    expect(restantes.map((a) => a.bloco).sort((a, b) => a - b)).toEqual([64, 96, 128]);
  });

  it('escolhe o ancestral mais proximo (o maior valido)', async () => {
    const { detector, cursors, anchors } = setup();
    const chain = fakeChain({ 64: '0xa64', 96: '0xa96', 128: '0xa128' });
    for (const b of [64, 96, 128]) {
      await anchors.record({
        chain: CHAIN, tokenContract: TOKEN, bloco: b, hashBloco: `0xa${b}`,
      });
    }
    await cursors.set(CHAIN, TOKEN, 150, '0xa150');
    // Nada mud abaixo de 128; o 150 e que diverge.
    chain.blocos.set(150, '0xOUTRO150');

    const r = await detector.checkWithFetcher(CHAIN, TOKEN, 150, '0xa150', chain.fetcher);
    expect(r.blocoSeguro).toBe(128);
  });

  it('pede reconstrucao total quando nao ha ancestral na janela', async () => {
    const { detector, cursors, anchors } = setup();
    const chain = fakeChain({ 64: '0xa64', 200: '0xa200' });
    await anchors.record({ chain: CHAIN, tokenContract: TOKEN, bloco: 64, hashBloco: '0xa64' });
    await cursors.set(CHAIN, TOKEN, 200, '0xa200');
    // Reorg tao profundo que ate a ancora 64 mudou.
    chain.blocos.set(64, '0xMUDOU64');
    chain.blocos.set(200, '0xMUDOU200');

    const r = await detector.checkWithFetcher(CHAIN, TOKEN, 200, '0xa200', chain.fetcher);
    expect(r.reorg).toBe(true);
    expect(r.reconstrucaoTotal).toBe(true);
    expect(r.blocoSeguro).toBe(64);
    expect(r.mensagem).toContain('reorg profundo');
  });

  it('trata reorg sem nenhuma ancora como reconstrucao total', async () => {
    const { detector, cursors } = setup();
    const chain = fakeChain({ 200: '0xNOVO200' });
    await cursors.set(CHAIN, TOKEN, 200, '0xa200');

    const r = await detector.checkWithFetcher(CHAIN, TOKEN, 200, '0xa200', chain.fetcher);
    expect(r.reorg).toBe(true);
    expect(r.reconstrucaoTotal).toBe(true);
    expect(r.blocoSeguro).toBe(0);
  });

  it('ignora ancoras acima do bloco do cursor', async () => {
    const { detector, cursors, anchors } = setup();
    const chain = fakeChain({ 64: '0xa64', 100: '0xNOVO100' });
    // Ancora acima do cursor nao pode ser candidata a ancestral.
    await anchors.record({ chain: CHAIN, tokenContract: TOKEN, bloco: 128, hashBloco: '0xqualquer' });
    await anchors.record({ chain: CHAIN, tokenContract: TOKEN, bloco: 64, hashBloco: '0xa64' });
    await cursors.set(CHAIN, TOKEN, 100, '0xa100');

    const r = await detector.checkWithFetcher(CHAIN, TOKEN, 100, '0xa100', chain.fetcher);
    expect(r.blocoSeguro).toBe(64);
  });
});

describe('C2: janela de retrospectiva', () => {
  it('a ancora mais antiga limita ate onde da para voltar', async () => {
    const { detector, anchors } = setup();
    for (const b of [32, 64, 96, 128, 160]) {
      await anchors.record({
        chain: CHAIN, tokenContract: TOKEN, bloco: b, hashBloco: `0xa${b}`,
      });
    }
    expect((await anchors.oldest(CHAIN, TOKEN))?.bloco).toBe(32);
  });

  it('devolve null quando nao ha ancora alguma', async () => {
    const { anchors } = setup();
    expect(await anchors.oldest(CHAIN, TOKEN)).toBeNull();
  });
});