import { Contract, type Provider } from 'ethers';
import { encodeTransfer, ERC20_ABI } from './erc20.js';
import { GasSponsor } from './gas-sponsor.js';
import { withinTolerance } from '../domain/money.js';
import type { PaymentLink } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { LinkStateMachine } from '../services/link-state-machine.js';
import type { MotorRepositories } from '../ports/index.js';
import { providerChainId, type ProviderFactory } from './provider.js';
import { ManualSigningRequired, type Signer } from '../signer/signer.js';

/**
 * Sweeper: move os tokens recebidos do endereco derivado (temporario) para a
 * carteira fria (destino final), assim que o pagamento tem confirmacoes.
 *
 * Passos:
 *  1. le o saldo do token no endereco derivado
 *  2. garante gas nativo (patrocinador) no endereco derivado
 *  3. monta e assina o transfer ERC-20 -> carteira fria
 *  4. transmite e acompanha a confirmacao
 *
 * Idempotencia: um link so vira 'movido' uma vez; o registro em
 * `movimentos_internos` guarda o tx_hash para reconciliacao.
 */

const SWEEPABLE_STATUSES = ['pago', 'parcial', 'pago_sem_gas'] as const;

export type SweeperOptions = {
  gasSponsorAmountWei: bigint;
  gasSponsorMinBalanceWei: bigint;
  /** Numero maximo de links processados por ciclo. */
  batchSize: number;
  /** A5: quantos links terminais checar por ciclo na reconciliacao. */
  reconcileBatchSize: number;
  /** Tolerancia para classificar pago vs parcial. */
  tolerancePct: number;
};

export type SweepResult = {
  processados: number;
  movidos: number;
  falhas: number;
  aguardandoGas: number;
  /** A5: links resgatados por saldo preso (sweep reorgado / falho). */
  resgatados: number;
  erros: string[];
};

export type SweeperDeps = {
  repos: MotorRepositories;
  providerFactory: ProviderFactory;
  signer: Signer;
  gasSponsor: GasSponsor;
  /** A4: mudancas de status passam pela maquina de estados. */
  linkState: LinkStateMachine;
  logger: Logger;
  options: SweeperOptions;
};

export class Sweeper {
  private running = false;

  constructor(private readonly deps: SweeperDeps) {}

  private get tolerancePct(): number {
    return this.deps.options.tolerancePct;
  }

  async runCycle(): Promise<SweepResult> {
    const result: SweepResult = {
      processados: 0,
      movidos: 0,
      falhas: 0,
      aguardandoGas: 0,
      resgatados: 0,
      erros: [],
    };
    if (this.running) return result;
    this.running = true;
    try {
      // A5: primeiro reavalia links que NAO estao na fila normal.
      // Um sweep reorgado (ou que o RPC deixou passar) deixa o saldo de
      // volta no endereco derivado com o link marcado como 'movido':
      // sem essa passagem, os fundos ficariam presos para sempre.
      await this.reconcileStrandedBalances(result);

      const processados = new Set<string>();
      for (const status of SWEEPABLE_STATUSES) {
        const links = await this.deps.repos.links.listByStatus(status, this.deps.options.batchSize);
        for (const link of links) {
          if (processados.has(link.id)) continue;
          processados.add(link.id);
          result.processados++;
          try {
            const outcome = await this.sweepLink(link.id);
            if (outcome === 'movido') result.movidos++;
            if (outcome === 'aguardando_gas') result.aguardandoGas++;
          } catch (err) {
            result.falhas++;
            const message = err instanceof Error ? err.message : String(err);
            result.erros.push(`${link.id}: ${message}`);
            this.deps.logger.error({ err, linkId: link.id }, 'falha no sweep');
          }
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * A5: reavalia links em estados terminais/ja movidos.
   *
   * Se o endereco derivado tem saldo, o dinheiro esta preso ali: ou o
   * sweep anterior caiu num reorg, ou a transacao sumiu do mempool.
   * O link volta para 'pago' (ou 'parcial') e volta a ser varrido.
   *
   * Regra de ouro: nunca recusar dinheiro que chegou.
   */
  private async reconcileStrandedBalances(result: SweepResult): Promise<void> {
    const { repos, logger } = this.deps;
    const candidates: PaymentLink['status'][] = ['movido', 'expirado', 'revogado'];

    for (const status of candidates) {
      const links = await repos.links.listByStatus(status, this.deps.options.reconcileBatchSize);
      if (links.length === 0) continue;

      // Agrupa por chain para nao abrir um provider por link.
      const porChain = new Map<string, PaymentLink[]>();
      for (const link of links) {
        const arr = porChain.get(link.chain) ?? [];
        arr.push(link);
        porChain.set(link.chain, arr);
      }

      for (const [chain, grupo] of porChain) {
        let provider;
        try {
          provider = this.deps.providerFactory(chain);
        } catch (err) {
          result.erros.push(`reconciliacao ${chain}: ${err instanceof Error ? err.message : err}`);
          continue;
        }

        for (const link of grupo) {
          try {
            const token = new Contract(link.tokenContract, ERC20_ABI, provider);
            const saldo = (await token.getFunction('balanceOf')(link.enderecoDeposito)) as bigint;
            if (saldo <= 0n) continue;

            // Saldo sem pagamento confirmado nao pode virar credito nem
            // 'pago'. Isso moveria dinheiro sem lastro contabil e poderia
            // creditar um cliente que nunca pagou. Deixa o saldo visivel
            // para conciliacao manual.
            const total = await repos.payments.sumConfirmedByLink(link.id);
            if (total <= 0n) {
              const jaSinalizado = (await repos.transfers.findByLink(link.id)).some(
                (t) => t.erro === 'saldo sem pagamento conciliado',
              );
              logger.error(
                { linkId: link.id, saldo: saldo.toString(), token: link.tokenContract },
                'saldo preso SEM pagamento conciliado: nao sera varrido automaticamente',
              );
              if (!jaSinalizado) {
                await repos.transfers.create({
                  linkId: link.id,
                  deAddress: link.enderecoDeposito,
                  paraAddress: '',
                  valorBaseUnits: saldo,
                  status: 'falhou',
                  erro: 'saldo sem pagamento conciliado',
                  chain,
                  bloco: null,
                  nonce: null,
                });
                await repos.audit.record({
                  ator: 'worker',
                  acao: 'sweep.saldo_sem_pagamento',
                  entidade: 'link',
                  entidadeId: link.id,
                  detalhes: {
                    statusAnterior: status,
                    saldoBaseUnits: saldo.toString(),
                    token: link.tokenContract,
                    chain,
                  },
                });
              }
              continue;
            }

            // Ha saldo preso COM pagamento conciliado: ressuscita o link
            // para a fila de sweep.
            const novo = await this.recomputeStatus(link);
            await repos.links.updateStatus(link.id, novo);
            result.resgatados++;
            logger.warn(
              { linkId: link.id, de: status, para: novo, saldo: saldo.toString() },
              'saldo preso encontrado em link fora da fila de sweep',
            );
            await repos.audit.record({
              ator: 'worker',
              acao: 'sweep.reconciliado',
              entidade: 'link',
              entidadeId: link.id,
              detalhes: {
                statusAnterior: status,
                statusNovo: novo,
                saldoBaseUnits: saldo.toString(),
                token: link.tokenContract,
                chain,
              },
            });
          } catch (err) {
            result.erros.push(
              `reconciliacao ${link.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
  }

  /** Recalcula 'pago' vs 'parcial' a partir do total já confirmado. */
  private async recomputeStatus(link: PaymentLink): Promise<'pago' | 'parcial'> {
    const total = await this.deps.repos.payments.sumConfirmedByLink(link.id);
    if (link.expectedBaseUnits && link.expectedBaseUnits > 0n) {
      const ok = withinTolerance(link.expectedBaseUnits, total, this.tolerancePct);
      return ok ? 'pago' : 'parcial';
    }
    return 'pago';
  }

  private async sweepLink(linkId: string): Promise<'movido' | 'aguardando_gas' | 'ignorado'> {
    const { repos, logger } = this.deps;
    const link = await repos.links.findById(linkId);
    if (!link) return 'ignorado';
    if (!(SWEEPABLE_STATUSES as readonly string[]).includes(link.status)) return 'ignorado';

    const provider = this.deps.providerFactory(link.chain);
    const token = new Contract(link.tokenContract, ERC20_ABI, provider);
    const balanceOf = token.getFunction('balanceOf');

    const saldo = (await balanceOf(link.enderecoDeposito)) as bigint;
    if (saldo <= 0n) {
      // A2: saldo zero NAO e falta de gas. "pago_sem_gas" significa
      // "recebeu, mas nao consegue pagar o proprio gas" -- usar esse status
      // aqui dava um diagnostico errado ao operador.
      // O status do link fica intacto para o proximo ciclo tentar de novo.
      logger.debug({ linkId: link.id }, 'saldo zero no endereco derivado: nada a mover');
      return 'ignorado';
    }

    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? undefined;
    const gasPrice = feeData.gasPrice ?? undefined;
    if (!maxFeePerGas && !gasPrice) {
      throw new Error('RPC nao retornou informacao de preco de gas');
    }

    // D3: se ja existe uma transacao pendente a partir do endereco derivado,
    // criar outracompetiria pelo mesmo nonce e poderia SUBSTITUIR o sweep
    // anterior. O caminho seguro e esperar o mempool limpar.
    const noncePendente = await provider.getTransactionCount(
      link.enderecoDeposito,
      'pending',
    );
    const nonceConfirmado = await provider.getTransactionCount(
      link.enderecoDeposito,
      'latest',
    );
    if (noncePendente > nonceConfirmado) {
      logger.debug(
        { linkId: link.id, noncePendente, nonceConfirmado },
        'sweep ja em andamento (nonce pendente): aguardando',
      );
      return 'ignorado';
    }

    // D4: idempotencia por (link, nonce). Se ja houve sweep com este nonce,
    // nao criamos outro registro nem outra transacao.
    const jaSwepeado = await repos.transfers.findByLink(link.id);
    const sweepDesteNonce = jaSwepeado.find(
      (t) =>
        t.status !== 'falhou' &&
        t.txHash !== null &&
        t.txHash !== '0x',
    );
    if (sweepDesteNonce) {
      logger.debug(
        { linkId: link.id, txHash: sweepDesteNonce.txHash },
        'link ja tem sweep registrado: nao duplicar',
      );
      return 'ignorado';
    }

    const sponsor = this.deps.gasSponsor;

    // Reutiliza a MESMA linha para (link, nonce). Criar outra estourava o
    // unique `movimentos_internos_link_nonce_uq` em toda retentativa apos
    // falha antes do broadcast.
    const existente = (await repos.transfers.findByLink(link.id)).find(
      (t) => t.nonce === nonceConfirmado,
    );
    let transfer;
    if (existente) {
      await repos.transfers.update(existente.id, {
        status: 'pendente',
        txHash: null,
        erro: null,
        valorBaseUnits: saldo,
        paraAddress: '',
        bloco: null,
      });
      transfer = {
        ...existente,
        status: 'pendente' as const,
        txHash: null,
        erro: null,
        valorBaseUnits: saldo,
        paraAddress: '',
        bloco: null,
      };
    } else {
      transfer = await repos.transfers.create({
        linkId: link.id,
        deAddress: link.enderecoDeposito,
        paraAddress: '',
        valorBaseUnits: saldo,
        status: 'pendente',
        chain: link.chain,
        bloco: null,
        nonce: nonceConfirmado,
      });
    }

    try {
      const needsGas = (await provider.getBalance(link.enderecoDeposito)) < BigInt(21000) * (maxFeePerGas ?? gasPrice ?? 0n);
      if (needsGas) {
        if (!sponsor.enabled) {
          await repos.transfers.update(transfer.id, {
            status: 'pendente',
            erro: 'sem gas sponsor configurado: o endereco derivado nao tem saldo nativo para pagar o gas',
          });
          await this.deps.linkState.transition({
            linkId: link.id,
            to: 'pago_sem_gas',
            reason: 'endereco derivado sem saldo nativo e sem gas sponsor configurado',
            actor: 'sweeper',
          });
          logger.error(
            { linkId: link.id },
            'gas sponsor nao configurado (GAS_SPONSOR_PRIVATE_KEY ausente)',
          );
          return 'aguardando_gas';
        }
        let sponsored: boolean;
        try {
          sponsored = await sponsor.ensureGas(provider, link.enderecoDeposito, {
            maxFeePerGas,
            gasPrice,
          });
        } catch (err) {
          // D5: o patrocinador pode estar sem saldo. Isso e operacional
          // (recarregar), nao um bug do link: o status correto e
          // 'pago_sem_gas' e o erro fica registrado para o operador agir.
          const mensagem = err instanceof Error ? err.message : String(err);
          await repos.transfers.update(transfer.id, { status: 'falhou', erro: mensagem });
          await this.deps.linkState.transition({
            linkId: link.id,
            to: 'pago_sem_gas',
            reason: `gas sponsor sem saldo: ${mensagem}`,
            actor: 'sweeper',
          });
          logger.error({ linkId: link.id, motivo: mensagem }, 'patrocinio de gas falhou');
          return 'aguardando_gas';
        }
        if (sponsored) {
          await repos.transfers.update(transfer.id, { status: 'patrocinado' });
        }
      }

      const carteiraFria = await this.resolveColdWallet(link);
      await repos.transfers.update(transfer.id, { paraAddress: carteiraFria });

      const nonce = await provider.getTransactionCount(link.enderecoDeposito, 'pending');
      const chainId = providerChainId(provider);
      const data = encodeTransfer(carteiraFria, saldo);

      let gasLimit = 120_000n;
      try {
        const estimate = await provider.estimateGas({
          from: link.enderecoDeposito,
          to: link.tokenContract,
          data,
          value: 0n,
        });
        gasLimit = (estimate * 120n) / 100n;
      } catch {
        // usa o limite padrao
      }

      const signed = await this.deps.signer.signTransfer({
        index: link.indiceHd,
        to: link.tokenContract,
        data,
        value: 0n,
        chainId,
        nonce,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
      });

      const tx = await provider.broadcastTransaction(signed.rawTransaction);
      await repos.transfers.update(transfer.id, {
        status: 'enviado',
        txHash: tx.hash,
      });
      logger.info({ linkId: link.id, txHash: tx.hash, valor: saldo.toString() }, 'sweep enviado');

      const receipt = await tx.wait(1, 120_000);
      if (receipt && receipt.status === 1) {
        // C5: guarda o bloco para saber depois se o sweep caiu num reorg.
        await repos.transfers.update(transfer.id, {
          status: 'confirmado',
          bloco: receipt.blockNumber,
        });

        // D2: o gas sponsor mandou POL para o endereco derivado; sobra um
        // pouco. Sem isso, cada link deixa poeira de nativo para sempre.
        await this.sweepNativeDust(link, provider, receipt, maxFeePerGas ?? gasPrice ?? 0n);

        await this.deps.linkState.transition({
          linkId: link.id,
          to: 'movido',
          reason: `sweep ${tx.hash} confirmado no bloco ${receipt.blockNumber}`,
          actor: 'sweeper',
        });
        logger.info({ linkId: link.id, txHash: tx.hash }, 'sweep confirmado');
        return 'movido';
      }

      await repos.transfers.update(transfer.id, {
        status: 'falhou',
        erro: 'transacao revertida',
      });
      throw new Error('transacao de sweep revertida');
    } catch (err) {
      if (err instanceof ManualSigningRequired) {
        await repos.transfers.update(transfer.id, {
          status: 'pendente',
          erro: 'assinatura manual necessaria',
        });
        logger.warn({ linkId: link.id }, 'transfer aguardando assinatura manual');
        return 'aguardando_gas';
      }
      const message = err instanceof Error ? err.message : String(err);
      await repos.transfers.update(transfer.id, { status: 'falhou', erro: message.slice(0, 500) });
      throw err;
    }
  }

  /**
   * D2: devolve o gas nativo restante para a carteira fria.
   *
   * O patrocinador mandou ~0,5 POL para o endereco derivado pagar o gas do
   * `transfer`. Sobra quase tudo. Sem esta limpeza, cada link deixa poeira
   * de nativo presa num enderece que ninguem mais vai usar.
   *
   * Reserva: o proprio envio custa gas, entao mandamos `saldo - reserva`.
   */
  private async sweepNativeDust(
    link: PaymentLink,
    provider: Provider,
    receipt: { gasUsed: bigint },
    maxFeePerGas: bigint,
  ): Promise<void> {
    const { repos, logger } = this.deps;
    try {
      const saldo = await provider.getBalance(link.enderecoDeposito);
      if (saldo <= 0n) return;

      // Reserva para o proprio envio + margem de 50%.
      const custoEnvio = BigInt(21_000) * maxFeePerGas;
      const reserva = (custoEnvio * 150n) / 100n;
      const aEnviar = saldo - reserva;
      if (aEnviar <= 0n) {
        logger.debug(
          { linkId: link.id, saldo: saldo.toString() },
          'saldo nativo menor que a reserva: dust fica no endereco',
        );
        return;
      }

      const destino = await this.resolveColdWallet(link);
      const nonce = await provider.getTransactionCount(link.enderecoDeposito, 'pending');
      const chainId = providerChainId(provider);
      const gasLimit = 21_000n;

      const signed = await this.deps.signer.signTransfer({
        index: link.indiceHd,
        to: destino,
        data: '0x',
        value: aEnviar,
        chainId,
        nonce,
        gasLimit,
        maxFeePerGas: maxFeePerGas > 0n ? maxFeePerGas : undefined,
      });

      const tx = await provider.broadcastTransaction(signed.rawTransaction);
      const dustReceipt = await tx.wait(1, 60_000);

      await repos.transfers.create({
        linkId: link.id,
        deAddress: link.enderecoDeposito,
        paraAddress: destino,
        valorBaseUnits: aEnviar,
        txHash: tx.hash,
        status: 'confirmado',
        chain: link.chain,
        bloco: dustReceipt?.blockNumber ?? null,
        nonce: Number(nonce) + 1,
        erro: 'retorno de gas nativo (dust)',
      });

      logger.debug(
        { linkId: link.id, txHash: tx.hash, valor: aEnviar.toString(), gasUsed: receipt.gasUsed.toString() },
        'gas nativo residual devolvido para a carteira fria',
      );
    } catch (err) {
      // Falha aqui e cosmética: o token ja esta seguro na carteira fria.
      // Nao vale falhar o sweep por causa de poeira.
      logger.warn(
        { err, linkId: link.id },
        'nao foi possivel devolver o gas nativo residual (token ja esta seguro)',
      );
    }
  }

  /**
   * Destino do sweep.
   *
   * A1: usa SEMPRE o endereco persistido no link (a escolha feita na UI).
   * O fallback por chain existe apenas para links legados criados antes da
   * correcao, e nesse caso emite aviso: o destino pode nao ser o esperado.
   */
  private async resolveColdWallet(link: {
    id: string;
    rampProfileId: string;
    chain: string;
    carteiraFriaEndereco: string | null;
  }): Promise<string> {
    if (link.carteiraFriaEndereco) return link.carteiraFriaEndereco;

    const wallets = await this.deps.repos.coldWallets.list();
    const candidate = wallets.find((w) => w.chain.toLowerCase() === link.chain.toLowerCase());
    if (candidate) {
      this.deps.logger.warn(
        { linkId: link.id, chain: link.chain, fallback: candidate.address },
        'link legado sem destino persistado: usando fallback por chain',
      );
      return candidate.address;
    }
    throw new Error(
      `nenhuma carteira fria para a chain "${link.chain}" e o link nao tem destino persistado`,
    );
  }
}
