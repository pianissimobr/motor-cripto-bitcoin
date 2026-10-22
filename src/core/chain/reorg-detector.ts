import type { Provider } from 'ethers';
import type { Logger } from '../logger.js';
import type { AnchorRepository, CursorRepository } from '../ports/index.js';

/**
 * C2/C3: deteccao e resolucao de reorg.
 *
 * Estratégia em duas camadas (ver ENDURECIMENTO.md):
 *
 *  1. **Teto em `finalized`** (config MONITOR_BLOCK_TAG): em cadeia com
 *     checkpoint, como a Polygon PoS, blocos finalizados nunca voltam.
 *     Isso ja elimina a grande maioria dos reorgs na origem.
 *
 *  2. **Ancora de hash** (defesa em profundidade): mesmo varrendo so
 *     finalizados, registramos o hash do bloco varrido e conferimos a cada
 *     ciclo. Se divergir (RPC trocado no meio do caminho, provedor
 *     mentiroso, cadeia sem finalidade), voltamos ate o ancestral comum
 *     usando as ancoras esparsas e pedimos rescan.
 *
 * Nada aqui mexe em dinheiro: o detector apenas devolve o bloco seguro e
 * o que precisa ser revogado. Quem decide o queagndo do reorg e o monitor.
 */

export type ReorgCheck = {
  /** Houve reorg? */
  reorg: boolean;
  /** Bloco valido (ancestral comum). Rewind do cursor ate aqui. */
  blocoSeguro: number;
  /** Quantas ancoras foram testadas ate achar o ancestral. */
  ancorasTestadas: number;
  /** true quando nao achou ancestral: o cursor precisa zerar. */
  reconstrucaoTotal: boolean;
  mensagem: string;
};

export type ReorgDetectorDeps = {
  cursors: CursorRepository;
  anchors: AnchorRepository;
  logger: Logger;
  /** Quantas ancoras voltar para tras antes de desistir. */
  maxAnchors: number;
};

/** Consulta o hash de um bloco; null se o bloco ainda nao existe. */
export type BlockHashFetcher = (bloco: number) => Promise<string | null>;

export class ReorgDetector {
  constructor(private readonly deps: ReorgDetectorDeps) {}

  /**
   * Confere se o cursor ainda e valido na chain.
   *
   * @param provider provider da chain (usado para ler o hash do bloco)
   */
  async check(
    chain: string,
    tokenContract: string,
    provider: Provider,
  ): Promise<ReorgCheck> {
    const cursor = await this.deps.cursors.get(chain, tokenContract);
    if (!cursor || cursor.ultimoBloco <= 0 || !cursor.hashBloco) {
      return {
        reorg: false,
        blocoSeguro: cursor?.ultimoBloco ?? 0,
        ancorasTestadas: 0,
        reconstrucaoTotal: false,
        mensagem: 'sem cursor valido para conferir',
      };
    }

    const fetchHash: BlockHashFetcher = async (bloco) => {
      const block = await provider.getBlock(bloco).catch(() => null);
      return block?.hash ?? null;
    };

    return this.checkWithFetcher(chain, tokenContract, cursor.ultimoBloco, cursor.hashBloco, fetchHash);
  }

  /**
   * Mesma logica, com a busca de hash injetada (usado nos testes para
   * simular uma chain reescrita sem depender de RPC).
   */
  async checkWithFetcher(
    chain: string,
    tokenContract: string,
    ultimoBloco: number,
    hashEsperado: string,
    fetchHash: BlockHashFetcher,
  ): Promise<ReorgCheck> {
    const hashAtual = await fetchHash(ultimoBloco);

    // Caso normal: o bloco no cursor bate com a chain.
    if (hashAtual === hashEsperado) {
      return {
        reorg: false,
        blocoSeguro: ultimoBloco,
        ancorasTestadas: 0,
        reconstrucaoTotal: false,
        mensagem: 'cursor confere com a chain',
      };
    }

    // Bloco ainda nao disponivel no RPC (lag): nao e reorg, e falta de dados.
    if (hashAtual === null) {
      this.deps.logger.debug(
        { chain, tokenContract, ultimoBloco },
        'bloco do cursor ainda nao visivel no RPC: sem reorg (lag de provider)',
      );
      return {
        reorg: false,
        blocoSeguro: ultimoBloco,
        ancorasTestadas: 0,
        reconstrucaoTotal: false,
        mensagem: 'bloco do cursor ainda nao visivel no RPC',
      };
    }

    // Divergiu de verdade: procura o ancestral comum.
    this.deps.logger.warn(
      { chain, tokenContract, ultimoBloco, esperado: hashEsperado, atual: hashAtual },
      'REORG detectado: hash do bloco do cursor divergiu da chain',
    );

    const key = tokenContract.toLowerCase();
    const anchors = await this.deps.anchors.list(chain, key, this.deps.maxAnchors);

    for (const anchor of anchors) {
      if (anchor.bloco >= ultimoBloco) continue;
      const hash = await fetchHash(anchor.bloco);
      if (hash !== null && hash.toLowerCase() === anchor.hashBloco.toLowerCase()) {
        await this.deps.anchors.pruneAfter(chain, key, anchor.bloco);
        await this.deps.cursors.rewind(chain, key, anchor.bloco, anchor.hashBloco);
        this.deps.logger.warn(
          { chain, blocoSeguro: anchor.bloco, descartadoAte: ultimoBloco },
          'ancestral comum encontrado: cursor rebobinado',
        );
        return {
          reorg: true,
          blocoSeguro: anchor.bloco,
          ancorasTestadas: anchors.filter((a) => a.bloco < ultimoBloco).length,
          reconstrucaoTotal: false,
          mensagem: `ancestral comum no bloco ${anchor.bloco}; refazer varredura ate ${ultimoBloco}`,
        };
      }
    }

    // Nenhum ancestral dentro da janela de ancoras: reconstrucao total.
    const maisAntiga = anchors.length > 0 ? anchors[anchors.length - 1]! : null;
    const piso = maisAntiga?.bloco ?? 0;
    this.deps.logger.error(
      { chain, piso, descartadoAte: ultimoBloco },
      'reorg profundo: nenhum ancestral na janela de ancoras',
    );
    return {
      reorg: true,
      blocoSeguro: piso,
      ancorasTestadas: anchors.length,
      reconstrucaoTotal: true,
      mensagem:
        'reorg profundo: nenhuma ancora compativel. ' +
        `cursor deve voltar ao bloco ${piso} e toda a regiao sera revarrida`,
    };
  }

  /**
   * Grava uma ancora quando o cursor avancou ao menos `interval` blocos
   * desde a ultima.
   *
   * O monitor avanca em saltos de `MONITOR_BLOCK_RANGE` (ex.: 2000), entao
   * exigir `bloco % interval === 0` fazia a ancora quase nunca ser gravada.
   * Comparar com a ultima ancora funciona para qualquer tamanho de salto.
   */
  async maybeAnchor(
    chain: string,
    tokenContract: string,
    bloco: number,
    hashBloco: string | null,
    interval: number,
  ): Promise<void> {
    if (!hashBloco || interval <= 0) return;
    const [ultima] = await this.deps.anchors.list(chain, tokenContract, 1);
    if (ultima && bloco - ultima.bloco < interval) return;
    if (ultima && ultima.bloco === bloco && ultima.hashBloco === hashBloco) return;
    await this.deps.anchors.record({
      chain,
      tokenContract: tokenContract.toLowerCase(),
      bloco,
      hashBloco,
    });
  }
}