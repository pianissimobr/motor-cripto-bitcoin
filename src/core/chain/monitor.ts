import { getAddress, type Log, type Provider } from 'ethers';
import { chainSpec } from './chains.js';
import { TRANSFER_TOPIC, addressToTopic, decodeTransferLog } from './erc20.js';
import { divRound, withinTolerance } from '../domain/money.js';
import type { LinkStatus, PaymentLink } from '../domain/types.js';
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

const ACTIVE_LINK_STATUSES: LinkStatus[] = ['aguardando', 'pago', 'parcial', 'pago_sem_gas', 'movido'];

export type MonitorOptions = {
  confirmationsRequired: number;
  tolerancePct: number;
  maxTopics: number;
  blockRange: number;
  startBlock: number;
};

export type CycleResult = {
  grupos: number;
  logsVarridos: number;
  pagamentosDetectados: number;
  pagamentosConfirmados: number;
  creditosCriados: number;
  erros: string[];
};

export type MonitorDeps = {
  repos: MotorRepositories;
  providerFactory: ProviderFactory;
  logger: Logger;
  options: MonitorOptions;
  /** A4: para validar transicoes de status. */
  linkState: LinkStateMachine;
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
      creditosCriados: 0,
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
      for (const profile of profiles) {
        const key = `${profile.chain}:${profile.tokenContract.toLowerCase()}`;
        if (!groups.has(key)) {
          groups.set(key, { chain: profile.chain, tokenContract: profile.tokenContract });
        }
      }

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
    const head = await provider.getBlockNumber();
    const cursor = await repos.cursors.get(chain, tokenContract.toLowerCase());

    const fromBlock = cursor
      ? cursor.ultimoBloco + 1
      : Math.max(this.deps.options.startBlock, head - this.deps.options.blockRange + 1);
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
      await repos.cursors.set(
        chain,
        tokenContract.toLowerCase(),
        lastScannedBlock,
        lastBlock?.hash ?? null,
      );
    }

    logger.debug(
      { chain, fromBlock, toBlock, logs: result.logsVarridos, detected },
      'varredura concluida',
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
    if (pending.length === 0) return;

    const heads = new Map<string, number>();
    for (const payment of pending) {
      const link = await repos.links.findById(payment.linkId);
      if (!link) continue;
      let head = heads.get(link.chain);
      if (head === undefined) {
        head = await this.deps.providerFactory(link.chain).getBlockNumber();
        heads.set(link.chain, head);
      }
      const confirmacoes = Math.max(0, head - payment.bloco + 1);
      if (confirmacoes !== payment.confirmacoes) {
        await repos.payments.updateConfirmations(payment.id, confirmacoes);
      }
      if (confirmacoes < this.deps.options.confirmationsRequired) continue;

      await repos.payments.upsert({
        linkId: payment.linkId,
        txHash: payment.txHash,
        logIndex: payment.logIndex,
        deAddress: payment.deAddress,
        paraAddress: payment.paraAddress,
        token: payment.token,
        valorBaseUnits: payment.valorBaseUnits,
        bloco: payment.bloco,
        status: 'confirmado',
        detectadoEm: payment.detectadoEm,
      });

      const credit = await this.creditPayment(link, payment.id, payment.valorBaseUnits);
      if (credit) result.creditosCriados++;

      const status = await this.linkStatusFor(link);
      // A4: passa pela maquina de estados (valida + audita o motivo).
      await this.deps.linkState.transition({
        linkId: link.id,
        to: status,
        reason: `${confirmacoes} confirmacoes, ${payment.valorBaseUnits} ${payment.token} recebido`,
        actor: 'monitor',
      });
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
    }
  }

  /** Credita o cliente com o valor EFETIVAMENTE recebido on-chain. */
  private async creditPayment(
    link: PaymentLink,
    pagamentoId: string,
    valorBaseUnits: bigint,
  ): Promise<boolean> {
    const { repos } = this.deps;
    const existing = await repos.credits.findByPayment(pagamentoId);
    if (existing) return false;

    const taxa = link.taxaTokenPorFiatBaseUnits;
    const valorCentavos =
      taxa && taxa > 0n
        ? Number(divRound(valorBaseUnits * 100n, taxa))
        : null;

    await repos.credits.create({
      clienteId: link.clienteId,
      linkId: link.id,
      pagamentoId,
      valorBaseUnits: valorBaseUnits,
      valorCentavos,
      moeda: link.asset,
      status: 'liberado',
    });
    return true;
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
