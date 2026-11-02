import { Contract, getAddress, type Log, type Provider } from 'ethers';
import { chainSpec } from './chains.js';
import { TRANSFER_TOPIC, addressToTopic, decodeTransferLog, ERC20_ABI } from './erc20.js';
import type { ReorgDetector } from './reorg-detector.js';
import { divRound, withinTolerance } from '../domain/money.js';
import { LINK_STATUS, type LinkStatus, type PaymentLink } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { LinkStateMachine } from '../services/link-state-machine.js';
import type { MotorRepositories } from '../ports/index.js';
import type { ProviderFactory } from './provider.js';

/**
 * Monitor on-chain: substitui o webhook que a Ramp so oferece para contas
 * business. Observa os enderecos derivados e detecta a entrada de stablecoin.
 *
 * Estrategia: polling de `eth_getLogs` com filtro de topics
 *   topic0 = Transfer(address,address,uint256)
 *   topic2 = enderecos de deposito (nosso endereco receptor)
 * O cursor por (chain, token) garante que nenhum bloco seja pulado.
 */

// Inclui expirado/nao_realizado: dinheiro que chega depois do prazo ainda
// precisa ser detectado, registrado e varrido (nunca recusar dinheiro).
const ACTIVE_LINK_STATUSES: LinkStatus[] = [
  'aguardando',
  'pago',
  'parcial',
  'pago_sem_gas',
  'expirado',
  'nao_realizado',
];

export type MonitorOptions = {
  confirmationsRequired: number;
  tolerancePct: number;
  maxTopics: number;
  blockRange: number;
  startBlock: number;
  /** C1: `finalized` so le blocos com checkpoint (nao voltam em reorg). */
  blockTag: 'finalized' | 'latest';
  /** C2: intervalo entre ancoras de hash. */
  anchorInterval: number;
  /** C3: quantas ancoras voltar atras antes de reconstrucao total. */
  maxReorgAnchors: number;
  /** Blocos para tras quando um aguardando tem saldo e o log nao foi visto. */
  backfillBlocks?: number;
};

export type CycleResult = {
  grupos: number;
  logsVarridos: number;
  pagamentosDetectados: number;
  pagamentosConfirmados: number;
  /** C3: reorgs detectados neste ciclo. */
  reorgsDetectados: number;
  /** C4: pagamentos revogados por reorg. */
  pagamentosRevogados: number;
  erros: string[];
};

export type MonitorDeps = {
  repos: MotorRepositories;
  providerFactory: ProviderFactory;
  logger: Logger;
  options: MonitorOptions;
  /** A4: para validar transicoes de status. */
  linkState: LinkStateMachine;
  /** C2/C3: deteccao de reorg. */
  reorgDetector: ReorgDetector;
  /** RPC opcional de conferencia. Ausente = um RPC so. */
  confirmProviderFactory?: ProviderFactory;
};

export class BlockchainMonitor {
  private running = false;

  constructor(private readonly deps: MonitorDeps) {}

  /** Executa um ciclo completo: varredura de logs + reconciliacao de confirmacoes. */
  async runCycle(): Promise<CycleResult> {
    const result: CycleResult = {
      grupos: 0,
      logsVarridos: 0,
      pagamentosDetectados: 0,
      pagamentosConfirmados: 0,
      reorgsDetectados: 0,
      pagamentosRevogados: 0,
      erros: [],
    };
    if (this.running) {
      this.deps.logger.debug('ciclo anterior ainda em execucao, pulando');
      return result;
    }
    this.running = true;
    try {
      const profiles = await this.deps.repos.rampProfiles.list();
      const groups = new Map<string, { chain: string; tokenContract: string }>();
      const remember = (chain: string, tokenContract: string) => {
        const key = `${chain.toLowerCase()}:${tokenContract.toLowerCase()}`;
        if (!groups.has(key)) groups.set(key, { chain, tokenContract });
      };
      for (const profile of profiles) remember(profile.chain, profile.tokenContract);
      const fromLinks = await this.deps.repos.links.listTokenPairs(ACTIVE_LINK_STATUSES);
      for (const pair of fromLinks) remember(pair.chain, pair.tokenContract);

      for (const group of groups.values()) {
        result.grupos++;
        try {
          await this.scanGroup(group.chain, group.tokenContract, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.erros.push(`${group.chain}: ${message}`);
          this.deps.logger.error({ err, chain: group.chain }, 'falha ao varrer a chain');
        }
      }

      await this.reconcileConfirmations(result);
      await this.backfillUnseenBalances(result);
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Varre os logs de um par (chain, token) e registra os pagamentos detectados. */
  private async scanGroup(
    chain: string,
    tokenContract: string,
    result: CycleResult,
  ): Promise<void> {
    const { repos, logger } = this.deps;
    const addresses = await repos.links.listDepositAddresses(ACTIVE_LINK_STATUSES);
    if (addresses.length === 0) return;

    const provider = this.deps.providerFactory(chain);

    // C3: antes de qualquer leitura, confere se o cursor ainda vale.
    // Um reorg aqui significa que o que "ja foi processado" pode nao existir.
    await this.checkReorg(chain, tokenContract, provider, result);

    // C1: teto da varredura. `finalized` na Polygon PoS tem checkpoint, ou
    // seja esses blocos nao voltam; `latest` inclui blocos reescrevivel.
    const head = await this.headBlock(provider);
    const cursor = await repos.cursors.get(chain, tokenContract.toLowerCase());

    const fromBlock = cursor
      ? cursor.ultimoBloco + 1
      : this.deps.options.startBlock > 0
        ? this.deps.options.startBlock
        : Math.max(0, head - this.deps.options.blockRange + 1);
    if (fromBlock > head) return;

    const toBlock = Math.min(head, fromBlock + this.deps.options.blockRange - 1);
    if (toBlock < fromBlock) return;

    const normalized = addresses.map((a) => addressToTopic(getAddress(a)));
    const chunks = chunk(normalized, this.deps.options.maxTopics);

    let detected = 0;
    let lastScannedBlock = fromBlock - 1;
    for (const addressesChunk of chunks) {
      const scan = await this.fetchLogs(provider, tokenContract, addressesChunk, fromBlock, toBlock);
      const logs = scan.logs;
      lastScannedBlock = Math.max(lastScannedBlock, scan.lastBlock);
      result.logsVarridos += logs.length;

      for (const log of logs) {
        if (log.removed) continue;
        if (!sameAddress(log.address, tokenContract)) continue;
        if (!log.transactionHash) continue;
        const decoded = decodeTransferLog(log);
        if (!decoded) continue;
        const link = await repos.links.findByDepositAddress(decoded.to);
        if (!link) continue;
        if (link.tokenContract.toLowerCase() !== tokenContract.toLowerCase()) continue;

        const payment = await repos.payments.upsert({
          linkId: link.id,
          txHash: log.transactionHash ?? '',
          logIndex: log.index,
          deAddress: decoded.from,
          paraAddress: decoded.to,
          token: link.asset,
          valorBaseUnits: decoded.value,
          bloco: log.blockNumber,
          status: 'detectado',
          detectadoEm: new Date(),
        });
        if (payment) detected++;
      }
    }
    result.pagamentosDetectados += detected;

    // O cursor so avanca ate o ultimo bloco REALMENTE coberto pelo RPC.
    // Se o provedor reduziu a faixa, avancar ate toBlock pularia blocos.
    if (lastScannedBlock >= fromBlock) {
      const lastBlock = await provider.getBlock(lastScannedBlock).catch(() => null);
      const hashBloco = lastBlock?.hash ?? null;
      await repos.cursors.set(chain, tokenContract.toLowerCase(), lastScannedBlock, hashBloco);
      // C2: ancora esparsa, para o detector achar o ancestral comum depois.
      await this.deps.reorgDetector.maybeAnchor(
        chain,
        tokenContract,
        lastScannedBlock,
        hashBloco,
        this.deps.options.anchorInterval,
      );
    }

    logger.debug(
      { chain, fromBlock, toBlock, logs: result.logsVarridos, detected },
      'varredura concluida',
    );
  }

  /**
   * C1: bloco com finalidade. Se o RPC nao souber, cai para `latest`.
   *
   * Na Polygon PoS o bloco `finalized` fica poucos blocos atras do `latest`
   * (medido: ~2 blocos / ~4s no publicnode), entao a latencia de credito
   * praticamente nao muda e a reorg deixa de ser uma ameaca.
   */
  private async headBlock(provider: Provider): Promise<number> {
    if (this.deps.options.blockTag === 'finalized') return this.finalizedBlock(provider);
    return provider.getBlockNumber();
  }

  private async finalizedBlock(provider: Provider): Promise<number> {
    let block: Awaited<ReturnType<Provider['getBlock']>> | null = null;
    try {
      block = await provider.getBlock('finalized');
    } catch (err) {
      throw new Error(
        "MONITOR_BLOCK_TAG=finalized, mas o RPC nao suporta o bloco 'finalized'. " +
          'Corrija o RPC ou mude explicitamente para latest (aceitando reorgs). ' +
          `Causa: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!block) {
      throw new Error(
        "MONITOR_BLOCK_TAG=finalized, mas o RPC retornou bloco 'finalized' vazio. " +
          'Nao caindo silenciosamente para latest.',
      );
    }
    return block.number;
  }

  /**
   * C3/C4: detecta reorg e desfaz o que foi registrado na regiao perdida.
   *
   * Pagamento confirmado que estava num bloco reescrito vira 'revertido',
   * o credito correspondente tambem, e o link volta a ser elegivel para
   * varredura (se o dinheiro chegou de novo em outro bloco, sera redetectado).
   */
  private async checkReorg(
    chain: string,
    tokenContract: string,
    provider: Provider,
    result: CycleResult,
  ): Promise<void> {
    const { repos, logger } = this.deps;

    const check = await this.deps.reorgDetector.check(chain, tokenContract, provider).catch((err) => {
      logger.warn(
        { err, chain },
        'falha ao checar reorg: seguindo sem rewind (o monitor vai revalidar)',
      );
      return null;
    });
    if (!check?.reorg) return;

    result.reorgsDetectados++;
    // Reorg profundo sem ancestral na janela devolve o piso das ancoras
    // (ou 0). Nao podemos reescrever o cursor antes de MONITOR_START_BLOCK:
    // isso faria o proximo ciclo varrer blocos que a config excluiu.
    const safe = Math.max(
      check.blocoSeguro,
      Math.max(0, this.deps.options.startBlock - 1),
    );

    // C3: sem rewind o cursor fica apontando para o bloco invalido e a
    // regiao reescrita nunca e varrida de novo. As ancoras acima do ponto
    // seguro tambem deixam de valer.
    await repos.cursors.rewind(chain, tokenContract, safe, null);
    await repos.anchors.pruneAfter(chain, tokenContract, safe);

    // C4: pagamentos primeiro; os links afetados sao recalculados abaixo.
    const atingidos = await repos.payments.listConfirmedAboveBlock(chain, safe);
    const revogados = await repos.payments.revertAboveBlock(chain, safe);
    result.pagamentosRevogados += revogados;

    // C5: um sweep cujo bloco caiu precisa ser refeito.
    const sweepsRefeitos = await repos.transfers.revertAboveBlock(chain, safe);

    // Links afetados sao recalculados: se ainda restar pagamento confirmado,
    // volta para pago/parcial; se nada restar, volta para aguardando (reorg).
    const afetados = new Set(atingidos.map((p) => p.linkId));
    for (const linkId of afetados) {
      const link = await repos.links.findById(linkId);
      if (!link) continue;
      const total = await repos.payments.sumConfirmedByLink(link.id);
      // Link terminal continua terminal se o pagamento sumir no reorg.
      const terminal = link.status === 'expirado' || link.status === 'nao_realizado';
      const destino: LinkStatus =
        total <= 0n
          ? terminal
            ? link.status
            : 'aguardando'
          : await this.linkStatusFor(link);
      if (link.status === destino) continue;
      await this.deps.linkState.transition({
        linkId,
        to: destino,
        reason:
          total <= 0n
            ? `reorg: pagamento revertido no bloco > ${safe}`
            : `reorg: restam ${total} ${link.asset} confirmados`,
        actor: 'monitor',
      });
    }

    await repos.audit.record({
      ator: 'monitor',
      acao: 'reorg.tratado',
      entidade: 'chain',
      entidadeId: `${chain}:${tokenContract.toLowerCase()}`,
      detalhes: {
        blocoSeguro: safe,
        reconstrucaoTotal: check.reconstrucaoTotal,
        pagamentosRevogados: revogados,
        sweepsRefeitos,
        mensagem: check.mensagem,
      },
    });

    logger.error(
      {
        chain,
        blocoSeguro: safe,
        pagamentosRevogados: revogados,
        sweepsRefeitos,
        reconstrucaoTotal: check.reconstrucaoTotal,
      },
      'reorg tratado: regiao descartada e revogada',
    );
  }

  /**
   * Busca logs cobrindo TODO o intervalo [fromBlock, toBlock].
   *
   * Varios RPCs publicos recusam faixas grandes ("invalid block range
   * params" / "too many results"). Aqui descobrimos o maior span aceito
   * (reduzindo por metade) e varremos o intervalo inteiro em sub-faixas
   * desse span. O cursor so avanca depois de cobrir tudo: nenhum bloco
   * pode ser pulado.
   */
  private async fetchLogs(
    provider: Provider,
    tokenContract: string,
    addresses: string[],
    fromBlock: number,
    toBlock: number,
  ): Promise<{ logs: Log[]; lastBlock: number }> {
    const filter = (start: number, end: number) => ({
      address: tokenContract,
      topics: [TRANSFER_TOPIC, null, addresses] as (string | null | string[])[],
      fromBlock: start,
      toBlock: end,
    });

    try {
      const logs = await provider.getLogs(filter(fromBlock, toBlock));
      return { logs, lastBlock: toBlock };
    } catch (err) {
      if (!isRangeError(err)) throw err;
      this.deps.logger.warn(
        { de: fromBlock, ate: toBlock },
        'RPC recusou a faixa de blocos, procurando um span menor',
      );
    }

    // Fase 1: descobrir o maior span aceito.
    let span = toBlock - fromBlock + 1;
    let probes = 0;
    let spanAceito = 1;
    while (probes < 12 && span >= 1) {
      try {
        await provider.getLogs(filter(fromBlock, fromBlock + span - 1));
        spanAceito = span;
        break;
      } catch (err) {
        if (!isRangeError(err)) throw err;
        span = Math.floor(span / 2);
        probes++;
      }
    }

    // Fase 2: varrer o intervalo inteiro em sub-faixas do span aceito.
    const logs: Log[] = [];
    for (let start = fromBlock; start <= toBlock; start += spanAceito) {
      const end = Math.min(toBlock, start + spanAceito - 1);
      const res = await provider.getLogs(filter(start, end));
      logs.push(...res);
    }
    return { logs, lastBlock: toBlock };
  }

  /** Confirma pagamentos que ja atingiram o numero de confirmacoes exigido. */
  private async reconcileConfirmations(result: CycleResult): Promise<void> {
    const { repos, logger } = this.deps;
    const pending = await repos.payments.listByStatus('detectado', 500);

    const heads = new Map<string, number>();
    for (const payment of pending) {
      try {
        const link = await repos.links.findById(payment.linkId);
        if (!link) continue;
        let head = heads.get(link.chain);
        if (head === undefined) {
          head = await this.headBlock(this.deps.providerFactory(link.chain));
          heads.set(link.chain, head);
        }
        const confirmacoes = Math.max(0, head - payment.bloco + 1);
        if (confirmacoes !== payment.confirmacoes) {
          await repos.payments.updateConfirmations(payment.id, confirmacoes);
        }
        if (confirmacoes < this.deps.options.confirmationsRequired) continue;

        const provider = this.deps.providerFactory(link.chain);
        const provado = await this.receiptConfirms(provider, payment.txHash, payment.logIndex, link.tokenContract);
        if (!provado) {
          result.erros.push(`${payment.id}: recibo nao confirma o log de transferencia`);
          continue;
        }
        const confirmProvider = this.confirmProvider(link.chain);
        if (confirmProvider) {
          const noOutro = await this.receiptConfirms(
            confirmProvider,
            payment.txHash,
            payment.logIndex,
            link.tokenContract,
          );
          const mesmoSaldo = await this.balancesAgree(provider, confirmProvider, link);
          if (!noOutro || !mesmoSaldo) {
            result.erros.push(`${payment.id}: RPC de conferencia divergiu do RPC principal`);
            continue;
          }
        }

        await repos.payments.confirm({
          paymentId: payment.id,
          confirmacoes,
        });

        await this.applyLinkStatus(
          link,
          confirmacoes,
          payment.valorBaseUnits,
          payment.token,
        );
        result.pagamentosConfirmados++;

        logger.info(
          {
            linkId: link.id,
            txHash: payment.txHash,
            confirmacoes,
            valorBaseUnits: payment.valorBaseUnits.toString(),
          },
          'pagamento confirmado',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.erros.push(`${payment.id}: ${message}`);
        logger.error({ err, paymentId: payment.id }, 'falha ao confirmar pagamento');
      }
    }

    // Recuperacao: cobre crash entre confirmacao e transicao do link.
    const leftovers = await repos.payments.listForReconciliation(500);
    for (const payment of leftovers) {
      try {
        const link = await repos.links.findById(payment.linkId);
        if (!link) continue;
        await this.applyLinkStatus(
          link,
          payment.confirmacoes,
          payment.valorBaseUnits,
          payment.token,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.erros.push(`${payment.id}: ${message}`);
        logger.error({ err, paymentId: payment.id }, 'falha ao reconciliar pagamento');
      }
    }
  }

  private async applyLinkStatus(
    link: PaymentLink,
    confirmacoes: number,
    valorBaseUnits: bigint,
    token: string,
  ): Promise<void> {
    const { repos } = this.deps;
    const total = await repos.payments.sumConfirmedByLink(link.id);
    await repos.links.updateSettlement(link.id, { valorRecebidoBaseUnits: total });

    if (total <= 0n) return;
    if (link.status === 'nao_realizado' || link.status === 'movido') return;

    const now = new Date();
    if (now > link.liquidacaoAte) {
      await repos.links.updateSettlement(link.id, {
        motivoNaoRealizado: 'pagamento_apos_prazo',
      });
      await this.deps.linkState.transition({
        linkId: link.id,
        to: 'nao_realizado',
        reason: `pagamento confirmado apos a janela de liquidacao (${valorBaseUnits} ${token})`,
        actor: 'monitor',
      });
      return;
    }

    const status = await this.linkStatusFor(link);
    await this.deps.linkState.transition({
      linkId: link.id,
      to: status,
      reason: `${confirmacoes} confirmacoes, ${valorBaseUnits} ${token} recebido`,
      actor: 'monitor',
    });
  }

  /** Calcula o status do link apos os pagamentos observados. */
  private async linkStatusFor(link: PaymentLink): Promise<LinkStatus> {
    const total = await this.deps.repos.payments.sumConfirmedByLink(link.id);
    if (total <= 0n) return link.status;

    if (link.expectedBaseUnits && link.expectedBaseUnits > 0n) {
      const ok = withinTolerance(
        link.expectedBaseUnits,
        total,
        this.deps.options.tolerancePct,
      );
      if (!ok) return 'parcial';
    }
    return 'pago';
  }

  private confirmProvider(chain: string): Provider | null {
    if (!this.deps.confirmProviderFactory) return null;
    try {
      return this.deps.confirmProviderFactory(chain);
    } catch {
      return null;
    }
  }

  /** O log da transferencia ainda esta num recibo de sucesso. */
  private async receiptConfirms(
    provider: Provider,
    txHash: string,
    logIndex: number,
    tokenContract: string,
  ): Promise<boolean> {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return false;
    return receipt.logs.some(
      (log) =>
        !log.removed &&
        log.index === logIndex &&
        (log.transactionHash ?? '').toLowerCase() === txHash.toLowerCase() &&
        sameAddress(log.address, tokenContract),
    );
  }

  private async balancesAgree(
    primary: Provider,
    confirm: Provider,
    link: PaymentLink,
  ): Promise<boolean> {
    const a = (await new Contract(link.tokenContract, ERC20_ABI, primary).getFunction('balanceOf')(
      link.enderecoDeposito,
    )) as bigint;
    const b = (await new Contract(link.tokenContract, ERC20_ABI, confirm).getFunction('balanceOf')(
      link.enderecoDeposito,
    )) as bigint;
    return a === b;
  }

  /**
   * Link aguardando com saldo e cujo log ficou fora da janela do cursor.
   * Relê só esses endereços. Saldo sem log vira alerta, não crédito.
   */
  private async backfillUnseenBalances(result: CycleResult): Promise<void> {
    const { repos, logger } = this.deps;
    const links = await repos.links.listByStatus('aguardando', 50);
    const lookback = this.deps.options.backfillBlocks ?? 100_000;

    for (const link of links) {
      try {
        const provider = this.deps.providerFactory(link.chain);
        const token = new Contract(link.tokenContract, ERC20_ABI, provider);
        const saldo = (await token.getFunction('balanceOf')(link.enderecoDeposito)) as bigint;
        if (saldo <= 0n) continue;

        const head = await this.headBlock(provider);
        const from = Math.max(this.deps.options.startBlock, head - lookback + 1);
        const topic = addressToTopic(getAddress(link.enderecoDeposito));
        const scan = await this.fetchLogs(provider, link.tokenContract, [topic], from, head);
        let found = 0;
        for (const log of scan.logs) {
          if (log.removed) continue;
          if (!sameAddress(log.address, link.tokenContract)) continue;
          if (!log.transactionHash) continue;
          const decoded = decodeTransferLog(log);
          if (!decoded) continue;
          if (!sameAddress(decoded.to, link.enderecoDeposito)) continue;
          const payment = await repos.payments.upsert({
            linkId: link.id,
            txHash: log.transactionHash,
            logIndex: log.index,
            deAddress: decoded.from,
            paraAddress: decoded.to,
            token: link.asset,
            valorBaseUnits: decoded.value,
            bloco: log.blockNumber,
            status: 'detectado',
            detectadoEm: new Date(),
          });
          if (payment) found++;
        }
        result.pagamentosDetectados += found;
        if (found > 0) continue;

        const jaSinalizado = (await repos.transfers.findByLink(link.id)).some(
          (t) => t.erro === 'saldo sem log de transferencia',
        );
        if (jaSinalizado) continue;
        await repos.transfers.create({
          linkId: link.id,
          deAddress: link.enderecoDeposito,
          paraAddress: '',
          valorBaseUnits: saldo,
          status: 'falhou',
          erro: 'saldo sem log de transferencia',
          chain: link.chain,
          bloco: null,
          nonce: null,
        });
        await repos.audit.record({
          ator: 'monitor',
          acao: 'monitor.saldo_sem_log',
          entidade: 'link',
          entidadeId: link.id,
          detalhes: {
            saldoBaseUnits: saldo.toString(),
            token: link.tokenContract,
            chain: link.chain,
            deBloco: from,
            ateBloco: head,
          },
        });
        logger.error(
          { linkId: link.id, saldo: saldo.toString() },
          'saldo no endereco de deposito sem log de transferencia na janela de backfill',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.erros.push(`backfill ${link.id}: ${message}`);
      }
    }
  }
}

function sameAddress(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** O RPC recusou a faixa de blocos ou o volume de resultados? */
function isRangeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('block range') ||
    message.includes('more than') ||
    message.includes('too many results') ||
    message.includes('query returned more than') ||
    message.includes('limit exceeded')
  );
}

export { chainSpec };
