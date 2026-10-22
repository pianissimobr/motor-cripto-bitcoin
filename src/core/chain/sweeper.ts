import { Contract, type Provider } from 'ethers';
import { encodeTransfer, ERC20_ABI } from './erc20.js';
import { GasSponsor } from './gas-sponsor.js';
import type { Logger } from '../logger.js';
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
};

export type SweepResult = {
  processados: number;
  movidos: number;
  falhas: number;
  aguardandoGas: number;
  erros: string[];
};

export type SweeperDeps = {
  repos: MotorRepositories;
  providerFactory: ProviderFactory;
  signer: Signer;
  gasSponsor: GasSponsor;
  logger: Logger;
  options: SweeperOptions;
};

export class Sweeper {
  private running = false;

  constructor(private readonly deps: SweeperDeps) {}

  async runCycle(): Promise<SweepResult> {
    const result: SweepResult = {
      processados: 0,
      movidos: 0,
      falhas: 0,
      aguardandoGas: 0,
      erros: [],
    };
    if (this.running) return result;
    this.running = true;
    try {
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
      // Nada a mover (pode ter sido movido em um ciclo anterior).
      const existing = await repos.transfers.findByLink(link.id);
      const done = existing.some((t) => t.status === 'confirmado');
      if (!done) {
        await repos.links.updateStatus(link.id, 'pago_sem_gas');
        logger.warn({ linkId: link.id }, 'saldo zero no endereco derivado');
      }
      return 'ignorado';
    }

    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? undefined;
    const gasPrice = feeData.gasPrice ?? undefined;
    if (!maxFeePerGas && !gasPrice) {
      throw new Error('RPC nao retornou informacao de preco de gas');
    }

    const sponsor = this.deps.gasSponsor;

    const transfer = await repos.transfers.create({
      linkId: link.id,
      deAddress: link.enderecoDeposito,
      paraAddress: '',
      valorBaseUnits: saldo,
      status: 'pendente',
    });

    try {
      const needsGas = (await provider.getBalance(link.enderecoDeposito)) < BigInt(21000) * (maxFeePerGas ?? gasPrice ?? 0n);
      if (needsGas) {
        if (!sponsor.enabled) {
          await repos.transfers.update(transfer.id, {
            status: 'pendente',
            erro: 'sem gas sponsor configurado: o endereco derivado nao tem saldo nativo para pagar o gas',
          });
          await repos.links.updateStatus(link.id, 'pago_sem_gas');
          logger.error(
            { linkId: link.id },
            'gas sponsor nao configurado (GAS_SPONSOR_PRIVATE_KEY ausente)',
          );
          return 'aguardando_gas';
        }
        const sponsored = await sponsor.ensureGas(provider, link.enderecoDeposito, {
          maxFeePerGas,
          gasPrice,
        });
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
        await repos.transfers.update(transfer.id, { status: 'confirmado' });
        await repos.links.updateStatus(link.id, 'movido');
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

  /** Descobre a carteira fria de destino do link. */
  private async resolveColdWallet(link: { rampProfileId: string; chain: string }): Promise<string> {
    const profile = await this.deps.repos.rampProfiles.findById(link.rampProfileId);
    const wallets = await this.deps.repos.coldWallets.list();
    const candidate = wallets.find((w) => w.chain.toLowerCase() === link.chain.toLowerCase());
    if (candidate) return candidate.address;
    throw new Error(
      `nenhuma carteira fria cadastrada para a chain "${link.chain}"` +
        (profile ? '' : ' (perfil Ramp nao encontrado)'),
    );
  }
}
