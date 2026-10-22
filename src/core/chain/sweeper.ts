import { Contract, getAddress, keccak256, type Provider, type Transaction } from 'ethers';
import { encodeTransfer, ERC20_ABI } from './erc20.js';
import { GasSponsor } from './gas-sponsor.js';
import { withinTolerance } from '../domain/money.js';
import type { InternalTransfer, PaymentLink } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { LinkStateMachine } from '../services/link-state-machine.js';
import type { MotorRepositories } from '../ports/index.js';
import { providerChainId, type ProviderFactory } from './provider.js';
import {
  assertSignedTransactionMatches,
  ManualSigningRequired,
  type Signer,
  type UnsignedTransaction,
} from '../signer/signer.js';

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
  /** PSBT: movimentos com unsigned persistida aguardando assinatura manual. */
  aguardandoAssinatura: number;
  /** A5: links resgatados por saldo preso (sweep reorgado / falho). */
  resgatados: number;
  erros: string[];
};

/** Erro de submissao manual com status HTTP seguro para a borda. */
export class TransferSubmissionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'TransferSubmissionError';
  }
}

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
      aguardandoAssinatura: 0,
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
            if (outcome === 'aguardando_assinatura') result.aguardandoAssinatura++;
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

  private async sweepLink(
    linkId: string,
  ): Promise<'movido' | 'aguardando_gas' | 'aguardando_assinatura' | 'ignorado'> {
    const { repos, logger } = this.deps;
    const link = await repos.links.findById(linkId);
    if (!link) return 'ignorado';
    if (!(SWEEPABLE_STATUSES as readonly string[]).includes(link.status)) return 'ignorado';

    const provider = this.deps.providerFactory(link.chain);

    // Recuperacao pos-crash: a raw assinada e o txHash sao gravados antes do
    // broadcast. Se o processo caiu depois de transmitir, retomamos a MESMA
    // transacao em vez de assinar outra com o mesmo nonce.
    const retomado = await this.resumeInFlight(link, provider);
    if (retomado !== 'none') return retomado;

    const token = new Contract(link.tokenContract, ERC20_ABI, provider);
    const balanceOf = token.getFunction('balanceOf');
    const saldo = (await balanceOf(link.enderecoDeposito)) as bigint;

    if (saldo <= 0n) {
      // O token pode ter saido, mas o registro do sweep nao foi concluido.
      // Se houver evidencia on-chain (nonce consumido / sweep confirmado),
      // fecha o link sem criar uma transacao nova.
      return this.recoverZeroBalanceSweep(link, provider);
    }

    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? undefined;
    const gasPrice = feeData.gasPrice ?? undefined;
    const feePerGas = maxFeePerGas ?? gasPrice;
    if (!feePerGas) {
      throw new Error('RPC nao retornou informacao de preco de gas');
    }

    // D3: se ja existe uma transacao pendente a partir do endereco derivado,
    // criar outra competiria pelo mesmo nonce e poderia SUBSTITUIR o sweep
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

    const carteiraFria = await this.resolveColdWallet(link);
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

    // D4 real: a chave e (link, tipo, nonce). Um dust no mesmo nonce do
    // token nao pode mais bloquear um sweep futuro.
    const existente = await repos.transfers.findByLinkKindNonce(
      link.id,
      'sweep',
      nonceConfirmado,
    );
    let transfer: InternalTransfer;
    if (existente) {
      if (existente.status === 'confirmado') {
        logger.debug(
          { linkId: link.id, nonce: nonceConfirmado },
          'sweep deste nonce ja confirmado: nao duplicar',
        );
        return 'ignorado';
      }

      // PSBT: a unsigned ja foi gerada e o operador precisa assina-la. Nao
      // regerar a cada ciclo (o operador perderia o payload valido).
      if (
        existente.unsignedTransaction &&
        existente.valorBaseUnits === saldo &&
        existente.paraAddress.toLowerCase() === carteiraFria.toLowerCase()
      ) {
        try {
          const unsigned = JSON.parse(existente.unsignedTransaction) as UnsignedTransaction;
          if (
            unsigned.chainId === providerChainId(provider) &&
            unsigned.nonce === nonceConfirmado
          ) {
            logger.info(
              { linkId: link.id, transferId: existente.id, nonce: nonceConfirmado },
              'sweep aguardando assinatura manual (PSBT)',
            );
            return 'aguardando_assinatura';
          }
        } catch {
          logger.warn(
            { linkId: link.id, transferId: existente.id },
            'unsigned PSBT invalida no banco; sera regenerada',
          );
        }
      }

      await repos.transfers.update(existente.id, {
        status: 'pendente',
        txHash: null,
        rawTransaction: null,
        unsignedTransaction: null,
        erro: null,
        valorBaseUnits: saldo,
        paraAddress: carteiraFria,
        bloco: null,
      });
      transfer = {
        ...existente,
        status: 'pendente',
        txHash: null,
        rawTransaction: null,
        unsignedTransaction: null,
        erro: null,
        valorBaseUnits: saldo,
        paraAddress: carteiraFria,
        bloco: null,
      };
    } else {
      transfer = await repos.transfers.create({
        linkId: link.id,
        deAddress: link.enderecoDeposito,
        paraAddress: carteiraFria,
        valorBaseUnits: saldo,
        status: 'pendente',
        chain: link.chain,
        bloco: null,
        nonce: nonceConfirmado,
        kind: 'sweep',
      });
    }

    try {
      const gasCost = gasLimit * feePerGas;
      let saldoNativo = await provider.getBalance(link.enderecoDeposito);

      if (saldoNativo < gasCost) {
        if (!this.deps.gasSponsor.enabled) {
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
            { linkId: link.id, gasCost: gasCost.toString(), saldoNativo: saldoNativo.toString() },
            'gas sponsor nao configurado (GAS_SPONSOR_PRIVATE_KEY ausente)',
          );
          return 'aguardando_gas';
        }

        let sponsored: boolean;
        try {
          sponsored = await this.deps.gasSponsor.ensureGas(provider, link.enderecoDeposito, {
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
        saldoNativo = await provider.getBalance(link.enderecoDeposito);
        if (saldoNativo < gasCost) {
          const mensagem = `gas insuficiente apos patrocinio: precisa ${gasCost.toString()}, tem ${saldoNativo.toString()}`;
          await repos.transfers.update(transfer.id, { status: 'falhou', erro: mensagem });
          await this.deps.linkState.transition({
            linkId: link.id,
            to: 'pago_sem_gas',
            reason: mensagem,
            actor: 'sweeper',
          });
          logger.error({ linkId: link.id, gasCost: gasCost.toString(), saldoNativo: saldoNativo.toString() }, mensagem);
          return 'aguardando_gas';
        }
      }

      const nonce = await provider.getTransactionCount(link.enderecoDeposito, 'latest');
      if (nonce !== nonceConfirmado) {
        logger.debug(
          { linkId: link.id, nonceEsperado: nonceConfirmado, nonceAtual: nonce },
          'nonce mudou durante o sweep: aguardando proximo ciclo',
        );
        return 'ignorado';
      }
      const chainId = providerChainId(provider);

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

      // Persiste a raw ANTES do broadcast. Se o processo morrer agora, o
      // proximo ciclo retoma exatamente esta transacao.
      const txHash = keccak256(signed.rawTransaction);
      await repos.transfers.update(transfer.id, {
        status: 'pendente',
        txHash,
        rawTransaction: signed.rawTransaction,
        erro: null,
      });

      const tx = await provider.broadcastTransaction(signed.rawTransaction);
      await repos.transfers.update(transfer.id, {
        status: 'enviado',
        txHash: tx.hash,
        rawTransaction: signed.rawTransaction,
      });
      logger.info({ linkId: link.id, txHash: tx.hash, valor: saldo.toString() }, 'sweep enviado');

      let receipt: Awaited<ReturnType<typeof tx.wait>>;
      try {
        receipt = await tx.wait(1, 120_000);
      } catch (err) {
        // Timeout nao significa falha: a tx pode confirmar depois. Mantem
        // 'enviado' + raw para a recuperacao do proximo ciclo.
        logger.warn(
          { err, linkId: link.id, txHash: tx.hash },
          'sweep transmitido mas ainda sem recibo; sera retomado',
        );
        return 'ignorado';
      }

      if (!receipt) {
        logger.warn({ linkId: link.id, txHash: tx.hash }, 'sweep sem recibo; sera retomado');
        return 'ignorado';
      }
      if (receipt.status === 1) {
        await this.finalizeSweep(link, transfer, receipt, provider, feePerGas);
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
          rawTransaction: null,
          unsignedTransaction: JSON.stringify(err.unsigned),
          erro: 'assinatura manual necessaria',
        });
        logger.warn(
          { linkId: link.id, transferId: transfer.id },
          'transfer aguardando assinatura manual',
        );
        return 'aguardando_assinatura';
      }
      const message = err instanceof Error ? err.message : String(err);
      await repos.transfers.update(transfer.id, { status: 'falhou', erro: message.slice(0, 500) });
      throw err;
    }
  }

  /**
   * Submete o raw assinado de uma unsigned PSBT. Valida que a assinatura
   * corresponde exatamente ao payload persistido antes de transmitir.
   */
  async submitSignedTransfer(
    transferId: string,
    rawTransaction: string,
  ): Promise<{ id: string; txHash: string; status: 'enviado' }> {
    const { repos, logger } = this.deps;
    const transfer = await repos.transfers.findById(transferId);
    if (!transfer) {
      throw new TransferSubmissionError('movimento nao encontrado', 404);
    }
    if (transfer.kind !== 'sweep' || !transfer.unsignedTransaction) {
      throw new TransferSubmissionError(
        'movimento nao esta aguardando assinatura manual',
        409,
      );
    }
    if (transfer.status !== 'pendente') {
      throw new TransferSubmissionError('movimento nao esta aguardando assinatura manual', 409);
    }

    const link = await repos.links.findById(transfer.linkId);
    if (!link) throw new TransferSubmissionError('link do movimento nao encontrado', 404);
    if (!(SWEEPABLE_STATUSES as readonly string[]).includes(link.status)) {
      throw new TransferSubmissionError('link nao esta em estado de sweep', 409);
    }

    let unsigned: UnsignedTransaction;
    try {
      unsigned = JSON.parse(transfer.unsignedTransaction) as UnsignedTransaction;
    } catch {
      throw new TransferSubmissionError('unsigned PSBT invalida', 409);
    }

    let expectedFrom: string;
    try {
      expectedFrom = getAddress(this.deps.signer.addressFor(link.indiceHd));
      if (getAddress(unsigned.from) !== expectedFrom) {
        throw new Error('remetente da unsigned nao corresponde ao indice do link');
      }
    } catch (err) {
      throw new TransferSubmissionError(
        `unsigned PSBT invalida: ${err instanceof Error ? err.message : String(err)}`,
        409,
      );
    }

    let tx: Transaction;
    try {
      tx = assertSignedTransactionMatches(rawTransaction, unsigned);
    } catch (err) {
      throw new TransferSubmissionError(
        err instanceof Error ? err.message : String(err),
        400,
      );
    }

    const provider = this.deps.providerFactory(link.chain);
    const chainId = providerChainId(provider);
    if (unsigned.chainId !== chainId) {
      throw new TransferSubmissionError('unsigned PSBT pertence a outra chain', 409);
    }

    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(link.enderecoDeposito, 'latest'),
      provider.getTransactionCount(link.enderecoDeposito, 'pending'),
    ]);
    if (pending > latest) {
      throw new TransferSubmissionError('ja existe transacao pendente para este endereco', 409);
    }
    if (tx.nonce !== latest) {
      throw new TransferSubmissionError(
        `nonce da unsigned (${tx.nonce}) nao corresponde ao nonce atual (${latest})`,
        409,
      );
    }

    const txHash = tx.hash ?? keccak256(rawTransaction);
    await repos.transfers.update(transfer.id, {
      status: 'pendente',
      txHash,
      rawTransaction,
      unsignedTransaction: null,
      erro: null,
    });

    try {
      const sent = await provider.broadcastTransaction(rawTransaction);
      await repos.transfers.update(transfer.id, {
        status: 'enviado',
        txHash: sent.hash,
        rawTransaction,
        unsignedTransaction: null,
        erro: null,
      });
      await repos.audit.record({
        ator: 'admin',
        acao: 'sweep.raw_submetido',
        entidade: 'movimento',
        entidadeId: transfer.id,
        detalhes: {
          linkId: link.id,
          txHash: sent.hash,
          nonce: tx.nonce,
          chain: link.chain,
        },
      });
      logger.info(
        { linkId: link.id, transferId: transfer.id, txHash: sent.hash },
        'raw PSBT submetido',
      );
      return { id: transfer.id, txHash: sent.hash, status: 'enviado' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await repos.transfers.update(transfer.id, {
        status: 'pendente',
        txHash,
        rawTransaction,
        unsignedTransaction: null,
        erro: `falha ao transmitir raw: ${message}`.slice(0, 500),
      });
      throw err;
    }
  }

  /**
   * Retoma um sweep ja assinado/transmitido. Retorna 'none' quando nao ha
   * nada em voo e o fluxo normal pode seguir.
   */
  private async resumeInFlight(
    link: PaymentLink,
    provider: Provider,
  ): Promise<'none' | 'movido' | 'ignorado'> {
    const { repos, logger } = this.deps;
    const transfer = (await repos.transfers.findByLink(link.id))
      .filter(
        (t) =>
          t.kind === 'sweep' &&
          ['pendente', 'patrocinado', 'enviado'].includes(t.status) &&
          (t.rawTransaction !== null || t.txHash !== null),
      )
      .at(-1);
    if (!transfer) return 'none';

    let receipt: Awaited<ReturnType<Provider['getTransactionReceipt']>> = null;
    if (transfer.txHash) {
      try {
        receipt = await provider.getTransactionReceipt(transfer.txHash);
      } catch (err) {
        logger.warn({ err, linkId: link.id }, 'falha ao consultar recibo do sweep; tentando rebroadcast');
      }
    }

    if (!receipt && transfer.rawTransaction) {
      try {
        const tx = await provider.broadcastTransaction(transfer.rawTransaction);
        await repos.transfers.update(transfer.id, {
          status: 'enviado',
          txHash: tx.hash,
          rawTransaction: transfer.rawTransaction,
          erro: null,
        });
        receipt = await tx.wait(1, 120_000);
      } catch (err) {
        const hash = transfer.txHash ?? keccak256(transfer.rawTransaction);
        try {
          receipt = await provider.getTransactionReceipt(hash);
        } catch {
          receipt = null;
        }
        if (!receipt) {
          logger.warn(
            { err, linkId: link.id, txHash: hash },
            'sweep em voo ainda nao confirmou; aguardando',
          );
          return 'ignorado';
        }
      }
    }

    if (!receipt) {
      logger.debug({ linkId: link.id, txHash: transfer.txHash }, 'sweep em voo sem recibo');
      return 'ignorado';
    }
    if (receipt.status !== 1) {
      await repos.transfers.update(transfer.id, {
        status: 'falhou',
        erro: 'transacao revertida',
      });
      logger.error({ linkId: link.id, txHash: transfer.txHash }, 'sweep em voo revertido');
      return 'ignorado';
    }

    const feeData = await provider.getFeeData();
    const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    await this.finalizeSweep(link, transfer, receipt, provider, feePerGas);
    return 'movido';
  }

  /**
   * Saldo zero pode significar que o sweep saiu, mas o registro nao foi
   * fechado (crash entre broadcast e update, por exemplo). So fecha o link
   * quando ha evidencia: sweep confirmado no banco ou nonce consumido sem
   * registro correspondente. Caso contrario, nao inventa movimento.
   */
  private async recoverZeroBalanceSweep(
    link: PaymentLink,
    provider: Provider,
  ): Promise<'movido' | 'ignorado'> {
    const { repos, logger } = this.deps;
    const transfers = await repos.transfers.findByLink(link.id);
    const sweeps = transfers.filter((t) => t.kind === 'sweep');
    const confirmado = sweeps.filter((t) => t.status === 'confirmado').at(-1);
    if (confirmado) {
      await this.ensureMovido(
        link,
        `sweep ${confirmado.txHash ?? 'sem hash'} ja confirmado`,
      );
      return 'movido';
    }

    const maiorNonceRegistrado = sweeps.reduce(
      (max, t) => (t.nonce !== null && t.nonce > max ? t.nonce : max),
      -1,
    );
    const nonceAtual = Number(
      await provider.getTransactionCount(link.enderecoDeposito, 'latest'),
    );
    if (nonceAtual <= Math.max(maiorNonceRegistrado, 0)) {
      logger.debug(
        { linkId: link.id, nonceAtual, maiorNonceRegistrado },
        'saldo zero sem evidencia de sweep transmitido',
      );
      return 'ignorado';
    }

    const nonceRecuperado = nonceAtual - 1;
    const recuperacaoExistente = await repos.transfers.findByLinkKindNonce(
      link.id,
      'recovery',
      nonceRecuperado,
    );
    if (recuperacaoExistente) {
      await this.ensureMovido(link, 'recuperacao sintetica ja registrada');
      return 'movido';
    }

    const total = await repos.payments.sumConfirmedByLink(link.id);
    const valor = total > 0n ? total : (link.expectedBaseUnits ?? 0n);
    await repos.transfers.create({
      linkId: link.id,
      deAddress: link.enderecoDeposito,
      paraAddress: '',
      valorBaseUnits: valor,
      status: 'confirmado',
      chain: link.chain,
      bloco: null,
      nonce: nonceRecuperado,
      kind: 'recovery',
      txHash: null,
      rawTransaction: null,
      erro: 'recuperacao sintetica: saldo zero e nonce consumido sem registro de sweep',
    });
    await repos.audit.record({
      ator: 'worker',
      acao: 'sweep.recuperacao_sintetica',
      entidade: 'link',
      entidadeId: link.id,
      detalhes: {
        nonce: nonceRecuperado,
        valorBaseUnits: valor.toString(),
        token: link.tokenContract,
        chain: link.chain,
        motivo: 'saldo zero e nonce consumido sem sweep confirmado no banco',
      },
    });
    logger.warn(
      { linkId: link.id, nonce: nonceRecuperado, valor: valor.toString() },
      'sweep recuperado sinteticamente (sem txHash)',
    );
    await this.ensureMovido(link, 'saldo zero e nonce consumido: sweep recuperado sinteticamente');
    return 'movido';
  }

  private async finalizeSweep(
    link: PaymentLink,
    transfer: InternalTransfer,
    receipt: { status: number | null; blockNumber: number; gasUsed: bigint },
    provider: Provider,
    feePerGas: bigint,
  ): Promise<void> {
    const { repos, logger } = this.deps;
    await repos.transfers.update(transfer.id, {
      status: 'confirmado',
      bloco: receipt.blockNumber,
      erro: null,
    });

    // D2: o gas sponsor mandou POL para o endereco derivado; sobra um
    // pouco. Sem isso, cada link deixa poeira de nativo para sempre.
    await this.sweepNativeDust(link, provider, receipt, feePerGas);

    await this.ensureMovido(
      link,
      `sweep ${transfer.txHash ?? 'sem hash'} confirmado no bloco ${receipt.blockNumber}`,
    );
    logger.info(
      { linkId: link.id, txHash: transfer.txHash, bloco: receipt.blockNumber },
      'sweep confirmado',
    );
  }

  private async ensureMovido(link: PaymentLink, reason: string): Promise<void> {
    const atual = await this.deps.repos.links.findById(link.id);
    if (!atual || atual.status === 'movido') return;
    await this.deps.linkState.transition({
      linkId: link.id,
      to: 'movido',
      reason,
      actor: 'sweeper',
    });
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
      const nonce = Number(
        await provider.getTransactionCount(link.enderecoDeposito, 'pending'),
      );
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

      const existente = await repos.transfers.findByLinkKindNonce(link.id, 'dust', nonce);
      if (existente && existente.status !== 'falhou') {
        logger.debug(
          { linkId: link.id, nonce, txHash: existente.txHash },
          'dust deste nonce ja registrado: nao duplicar',
        );
        return;
      }

      const txHash = keccak256(signed.rawTransaction);
      if (existente) {
        await repos.transfers.update(existente.id, {
          status: 'pendente',
          txHash,
          rawTransaction: signed.rawTransaction,
          valorBaseUnits: aEnviar,
          paraAddress: destino,
          bloco: null,
          erro: 'retorno de gas nativo (dust)',
        });
      } else {
        await repos.transfers.create({
          linkId: link.id,
          deAddress: link.enderecoDeposito,
          paraAddress: destino,
          valorBaseUnits: aEnviar,
          txHash,
          status: 'pendente',
          chain: link.chain,
          bloco: null,
          nonce,
          kind: 'dust',
          rawTransaction: signed.rawTransaction,
          erro: 'retorno de gas nativo (dust)',
        });
      }

      const tx = await provider.broadcastTransaction(signed.rawTransaction);
      await repos.transfers.update(
        existente?.id ?? (await repos.transfers.findByLinkKindNonce(link.id, 'dust', nonce))!.id,
        { status: 'enviado', txHash: tx.hash, rawTransaction: signed.rawTransaction },
      );

      let dustReceipt: Awaited<ReturnType<typeof tx.wait>>;
      try {
        dustReceipt = await tx.wait(1, 60_000);
      } catch (err) {
        logger.warn(
          { err, linkId: link.id, txHash: tx.hash },
          'dust transmitido mas sem recibo (token ja esta seguro)',
        );
        return;
      }

      const dust = await repos.transfers.findByLinkKindNonce(link.id, 'dust', nonce);
      if (dust) {
        await repos.transfers.update(dust.id, {
          status: dustReceipt?.status === 1 ? 'confirmado' : 'falhou',
          bloco: dustReceipt?.blockNumber ?? null,
          erro:
            dustReceipt?.status === 1
              ? 'retorno de gas nativo (dust)'
              : 'transacao de dust revertida',
        });
      }

      logger.debug(
        {
          linkId: link.id,
          txHash: tx.hash,
          valor: aEnviar.toString(),
          gasUsed: receipt.gasUsed.toString(),
        },
        'gas nativo residual devolvido para a carteira fria',
      );
    } catch (err) {
      // Falha aqui e cosmetica: o token ja esta seguro na carteira fria.
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
