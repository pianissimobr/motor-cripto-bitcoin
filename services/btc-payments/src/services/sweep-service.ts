import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import type { AppConfig } from '../config.js';
import type { EsploraClient } from '../adapters/chain/esplora.js';
import { networkFor } from '../adapters/hd/derivation.js';
import type { SweepSigner } from '../adapters/signer/sweep-signer.js';
import type { Repositories, SweepCandidate } from '../db/repositories.js';
import type { HdAddress, OnchainSweep, SweepInput } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';

const DUST_SATS = 546n;
const RBF_SEQUENCE = 0xfffffffd;

export type SweepServiceDeps = {
  repos: Repositories;
  esplora: EsploraClient;
  signer: SweepSigner;
  config: AppConfig;
  logger: Logger;
  alerts?: AlertService;
  now?: () => Date;
};

export type SweepCycleResult = {
  candidates: number;
  created: number;
  broadcast: number;
  manual: number;
  failed: number;
  monitored: number;
  swept: number;
  rbf: number;
  errors: number;
};

type Group = {
  intentId: string;
  addressId: string;
  address: string;
  addressIndex: number;
  inputs: SweepInput[];
  total: bigint;
};

export function estimateSweepVsize(nInputs: number, nOutputs = 1): number {
  // P2WPKH: ~68 vbytes por input e ~31 por output, mais overhead.
  return 10 + 68 * nInputs + 31 * nOutputs;
}

export class SweepService {
  constructor(private readonly deps: SweepServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private minOutput(): bigint {
    const configured = this.deps.config.sweep.minSats;
    return configured > DUST_SATS ? configured : DUST_SATS;
  }

  private maxFeeBps(): bigint {
    return BigInt(Math.floor(this.deps.config.sweep.maxFeePct * 10_000));
  }

  async runCycle(
    limit = this.deps.config.jobs.batchSize,
  ): Promise<SweepCycleResult> {
    const monitor = await this.monitorSweeps(limit);
    const create = await this.createSweeps(limit);
    return {
      ...create,
      ...monitor,
      created: create.created,
      candidates: create.candidates,
      broadcast: create.broadcast,
      manual: create.manual + monitor.manual,
      failed: create.failed + monitor.failed,
      errors: create.errors + monitor.errors,
      swept: monitor.swept,
      rbf: monitor.rbf,
      monitored: monitor.monitored,
    };
  }

  private async createSweeps(
    limit: number,
  ): Promise<Omit<SweepCycleResult, 'monitored' | 'swept' | 'rbf'>> {
    const candidates = await this.deps.repos.listConfirmedOnchainPaymentsForSweep(
      limit,
      {
        confirmations: this.deps.config.onchain.confirmations,
        highValueSats: this.deps.config.onchain.highValueSats,
        highValueConfirmations: this.deps.config.onchain.highValueConfirmations,
      },
    );
    const result = {
      candidates: candidates.length,
      created: 0,
      broadcast: 0,
      manual: 0,
      failed: 0,
      errors: 0,
    };
    if (candidates.length === 0) return result;

    const coldWallet = this.deps.config.sweep.coldWalletAddress;
    if (!coldWallet) {
      this.deps.logger.error('SWEEP_ENABLED sem COLD_WALLET_ADDRESS');
      result.errors++;
      return result;
    }

    for (const group of this.groupCandidates(candidates)) {
      try {
        const outcome = await this.createSweep(group, coldWallet);
        if (outcome === 'broadcast') {
          result.created++;
          result.broadcast++;
        } else if (outcome === 'manual') {
          result.created++;
          result.manual++;
        } else if (outcome === 'failed') {
          result.failed++;
        }
      } catch (err) {
        result.errors++;
        this.deps.logger.error(
          { err, addressId: group.addressId, intentId: group.intentId },
          'erro ao criar sweep',
        );
      }
    }
    return result;
  }

  private groupCandidates(candidates: SweepCandidate[]): Group[] {
    const groups = new Map<string, Group>();
    for (const candidate of candidates) {
      const key = `${candidate.intentId}:${candidate.addressId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          intentId: candidate.intentId,
          addressId: candidate.addressId,
          address: candidate.address,
          addressIndex: candidate.addressIndex,
          inputs: [],
          total: 0n,
        };
        groups.set(key, group);
      }
      group.inputs.push({
        txid: candidate.txid,
        vout: candidate.vout,
        amountSats: candidate.amountSats.toString(),
      });
      group.total += candidate.amountSats;
    }
    return [...groups.values()];
  }

  private async createSweep(
    group: Group,
    coldWallet: string,
  ): Promise<'broadcast' | 'manual' | 'failed' | 'skipped'> {
    const address = await this.deps.repos.findHdAddressById(group.addressId);
    if (!address) return 'skipped';

    const feeRate = await this.feeRate();
    const vsize = estimateSweepVsize(group.inputs.length, 1);
    const feeSats = BigInt(vsize * feeRate);
    const output = group.total - feeSats;
    const inputs = group.inputs;

    const invalidReason = this.validateOutput(group.total, feeSats, output);
    if (invalidReason) {
      const claimed = await this.deps.repos.claimSweep({
        intentId: group.intentId,
        addressId: group.addressId,
        amountSats: group.total,
        feeSats,
        coldWalletAddress: coldWallet,
        inputs,
        status: 'manual',
        lastError: invalidReason,
      });
      if (claimed) {
        await this.audit('sweep.manual', claimed, {
          reason: invalidReason,
          amountSats: group.total.toString(),
          feeSats: feeSats.toString(),
        });
        this.deps.logger.warn(
          {
            sweepId: claimed.id,
            intentId: group.intentId,
            amountSats: group.total.toString(),
            feeSats: feeSats.toString(),
            reason: invalidReason,
          },
          'sweep requer intervencao manual',
        );
      }
      return 'manual';
    }

    const tx = this.buildTransaction(group, address, coldWallet, output);
    const psbt = hex.encode(tx.toPSBT());
    const claimed = await this.deps.repos.claimSweep({
      intentId: group.intentId,
      addressId: group.addressId,
      amountSats: group.total,
      feeSats,
      coldWalletAddress: coldWallet,
      inputs,
      status: 'construindo',
    });
    if (!claimed) return 'skipped';

    try {
      const signed = await this.deps.signer.signSweep({
        psbt,
        inputs: inputs.map(() => ({ addressIndex: group.addressIndex })),
        network: this.deps.config.btc.network,
      });
      if (signed.kind === 'manual') {
        await this.deps.repos.updateSweep({
          id: claimed.id,
          status: 'manual',
          psbt: signed.psbt,
          lastError: 'assinatura manual necessaria (SIGNER_MODE=psbt)',
          lastCheckedAt: this.now(),
        });
        await this.audit('sweep.manual', claimed, {
          reason: 'assinatura manual',
          amountSats: group.total.toString(),
        });
        return 'manual';
      }

      const broadcastTxid = await this.deps.esplora.broadcastTx(signed.rawTx);
      if (broadcastTxid.toLowerCase() !== signed.txid.toLowerCase()) {
        throw new Error(
          `txid do broadcast (${broadcastTxid}) nao confere com o txid assinado (${signed.txid})`,
        );
      }

      const updated = await this.deps.repos.updateSweep({
        id: claimed.id,
        status: 'aguardando_confirmacao_rede',
        txid: signed.txid,
        psbt: signed.psbt,
        rawTx: signed.rawTx,
        feeSats,
        confirmations: 0,
        lastCheckedAt: this.now(),
        lastBroadcastAt: this.now(),
        attempts: 0,
        lastError: null,
      });
      await this.deps.repos.markOnchainPaymentsGasto(inputs);
      if (updated) {
        await this.audit('sweep.broadcast', updated, {
          txid: signed.txid,
          amountSats: group.total.toString(),
          feeSats: feeSats.toString(),
        });
      }
      this.deps.logger.info(
        {
          sweepId: claimed.id,
          intentId: group.intentId,
          txid: signed.txid,
          amountSats: group.total.toString(),
          feeSats: feeSats.toString(),
        },
        'sweep transmitido',
      );
      return 'broadcast';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.repos.updateSweep({
        id: claimed.id,
        status: 'falhou',
        lastError: message,
        lastCheckedAt: this.now(),
      });
      await this.audit('sweep.failed', claimed, { reason: message });
      this.deps.logger.error(
        { err, sweepId: claimed.id, intentId: group.intentId },
        'falha ao assinar/transmitir sweep',
      );
      await this.deps.alerts?.send({
        level: 'error',
        title: 'sweep falhou ao assinar/transmitir',
        message,
        metadata: {
          sweepId: claimed.id,
          intentId: group.intentId,
          amountSats: group.total.toString(),
        },
      });
      return 'failed';
    }
  }

  private async monitorSweeps(limit: number): Promise<{
    monitored: number;
    swept: number;
    rbf: number;
    manual: number;
    failed: number;
    errors: number;
  }> {
    const sweeps = await this.deps.repos.listSweepsToMonitor(limit);
    const result = {
      monitored: 0,
      swept: 0,
      rbf: 0,
      manual: 0,
      failed: 0,
      errors: 0,
    };
    for (const sweep of sweeps) {
      result.monitored++;
      try {
        await this.monitorSweep(sweep, result);
      } catch (err) {
        result.errors++;
        this.deps.logger.error(
          { err, sweepId: sweep.id },
          'erro ao monitorar sweep',
        );
      }
    }
    return result;
  }

  private async monitorSweep(
    sweep: OnchainSweep,
    result: {
      swept: number;
      rbf: number;
      manual: number;
      errors: number;
    },
  ): Promise<void> {
    const now = this.now();
    if (!sweep.txid) {
      await this.manualSweep(sweep, 'sweep sem txid');
      result.manual++;
      return;
    }

    let tx;
    try {
      tx = await this.deps.esplora.getTx(sweep.txid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const recent = now.getTime() - sweep.updatedAt.getTime() < 60_000;
      if (message.includes('404') && !recent) {
        await this.manualSweep(sweep, 'tx do sweep nao encontrada na rede');
        result.manual++;
      } else {
        await this.deps.repos.updateSweep({
          id: sweep.id,
          lastCheckedAt: now,
          lastError: message,
        });
        result.errors++;
      }
      return;
    }

    if (tx.status.confirmed && tx.status.block_height !== undefined) {
      const tip = await this.deps.esplora.getTipHeight();
      const confirmations = Math.max(0, tip - tx.status.block_height + 1);
      await this.deps.repos.updateSweep({
        id: sweep.id,
        status: 'sweepado',
        confirmations,
        lastCheckedAt: now,
        lastError: null,
      });
      await this.deps.repos.markOnchainPaymentsGasto(sweep.inputs);
      await this.audit('sweep.confirmed', sweep, {
        txid: sweep.txid,
        confirmations,
        amountSats: sweep.amountSats.toString(),
      });
      result.swept++;
      this.deps.logger.info(
        { sweepId: sweep.id, txid: sweep.txid, confirmations },
        'sweep confirmado',
      );
      return;
    }

    await this.deps.repos.updateSweep({
      id: sweep.id,
      status: 'aguardando_confirmacao_rede',
      confirmations: 0,
      lastCheckedAt: now,
    });

    const rbfAfterMs = this.deps.config.sweep.rbfAfterSeconds * 1000;
    const broadcastAt = sweep.lastBroadcastAt ?? sweep.createdAt;
    if (
      now.getTime() - broadcastAt.getTime() >= rbfAfterMs &&
      sweep.attempts < this.deps.config.sweep.maxAttempts
    ) {
      const outcome = await this.tryRbf(sweep);
      if (outcome === 'rbf') result.rbf++;
      else if (outcome === 'manual') result.manual++;
      return;
    }

    if (
      sweep.attempts >= this.deps.config.sweep.maxAttempts &&
      now.getTime() - broadcastAt.getTime() >= rbfAfterMs
    ) {
      await this.manualSweep(
        sweep,
        'maximo de RBF atingido sem confirmacao; revisar manualmente',
      );
      result.manual++;
    }
  }

  private async tryRbf(
    sweep: OnchainSweep,
  ): Promise<'rbf' | 'manual' | 'skipped'> {
    if (sweep.inputs.length === 0) {
      await this.manualSweep(sweep, 'sweep sem inputs para RBF');
      return 'manual';
    }
    const address = await this.deps.repos.findHdAddressById(sweep.addressId);
    const coldWallet = sweep.coldWalletAddress ?? this.deps.config.sweep.coldWalletAddress;
    if (!address || !coldWallet) {
      await this.manualSweep(sweep, 'endereco/carteira fria ausente para RBF');
      return 'manual';
    }

    const total = sweep.inputs.reduce(
      (acc, input) => acc + BigInt(input.amountSats),
      0n,
    );
    const vsize = estimateSweepVsize(sweep.inputs.length, 1);
    const oldFee = sweep.feeSats ?? 0n;
    const oldRate = oldFee > 0n ? Math.ceil(Number(oldFee) / vsize) : 1;
    const estimatedRate = await this.feeRate();
    const newRate = Math.max(estimatedRate, Math.ceil(oldRate * 1.5));
    const newFee = BigInt(vsize * newRate);
    const output = total - newFee;

    const invalidReason = this.validateOutput(total, newFee, output);
    if (invalidReason) {
      await this.manualSweep(sweep, `RBF inviavel: ${invalidReason}`);
      return 'manual';
    }

    const tx = this.buildTransaction(
      {
        intentId: sweep.intentId,
        addressId: sweep.addressId,
        address: address.address,
        addressIndex: address.index,
        inputs: sweep.inputs,
        total,
      },
      address,
      coldWallet,
      output,
    );
    const psbt = hex.encode(tx.toPSBT());
    try {
      const signed = await this.deps.signer.signSweep({
        psbt,
        inputs: sweep.inputs.map(() => ({ addressIndex: address.index })),
        network: this.deps.config.btc.network,
      });
      if (signed.kind === 'manual') {
        await this.deps.repos.updateSweep({
          id: sweep.id,
          status: 'manual',
          psbt: signed.psbt,
          lastError: 'RBF requer assinatura manual',
          lastCheckedAt: this.now(),
        });
        return 'manual';
      }
      const broadcastTxid = await this.deps.esplora.broadcastTx(signed.rawTx);
      if (broadcastTxid.toLowerCase() !== signed.txid.toLowerCase()) {
        throw new Error('txid do RBF nao confere com o txid assinado');
      }
      await this.deps.repos.updateSweep({
        id: sweep.id,
        status: 'aguardando_confirmacao_rede',
        txid: signed.txid,
        psbt: signed.psbt,
        rawTx: signed.rawTx,
        feeSats: newFee,
        attempts: sweep.attempts + 1,
        lastCheckedAt: this.now(),
        lastBroadcastAt: this.now(),
        lastError: null,
      });
      await this.audit('sweep.rbf', sweep, {
        oldTxid: sweep.txid,
        newTxid: signed.txid,
        oldFeeSats: oldFee.toString(),
        newFeeSats: newFee.toString(),
      });
      this.deps.logger.warn(
        {
          sweepId: sweep.id,
          oldTxid: sweep.txid,
          newTxid: signed.txid,
          newFeeSats: newFee.toString(),
        },
        'sweep reenviado com RBF',
      );
      return 'rbf';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.manualSweep(sweep, `RBF falhou: ${message}`);
      return 'manual';
    }
  }

  private buildTransaction(
    group: Group,
    address: HdAddress,
    coldWallet: string,
    output: bigint,
  ): btc.Transaction {
    const network = networkFor(this.deps.config.btc.network);
    const decoded = btc.Address(network).decode(address.address);
    const script = btc.OutScript.encode(decoded);
    const tx = new btc.Transaction();
    for (const input of group.inputs) {
      tx.addInput({
        txid: input.txid,
        index: input.vout,
        witnessUtxo: { script, amount: BigInt(input.amountSats) },
        sequence: RBF_SEQUENCE,
      });
    }
    tx.addOutputAddress(coldWallet, output, network);
    return tx;
  }

  private validateOutput(
    total: bigint,
    feeSats: bigint,
    output: bigint,
  ): string | null {
    if (feeSats <= 0n) return 'taxa calculada invalida';
    if (output < this.minOutput()) {
      return `valor restante (${output.toString()} sats) abaixo do minimo/poeira (${this.minOutput().toString()})`;
    }
    const maxFeeBps = this.maxFeeBps();
    if (maxFeeBps > 0n && feeSats * 10_000n > total * maxFeeBps) {
      return `taxa (${feeSats.toString()} sats) acima do limite de ${this.deps.config.sweep.maxFeePct * 100}%`;
    }
    return null;
  }

  private async feeRate(): Promise<number> {
    const estimates = await this.deps.esplora.getFeeEstimates();
    const keys = Object.keys(estimates)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const target = this.deps.config.sweep.feeTargetBlocks;
    const key = keys.find((k) => k >= target) ?? keys[keys.length - 1];
    const base = key !== undefined ? Number(estimates[String(key)]) : 1;
    const valid = Number.isFinite(base) && base > 0 ? base : 1;
    return Math.max(1, Math.ceil(valid * this.deps.config.sweep.feeMultiplier));
  }

  private async manualSweep(sweep: OnchainSweep, reason: string): Promise<void> {
    await this.deps.repos.updateSweep({
      id: sweep.id,
      status: 'manual',
      lastError: reason,
      lastCheckedAt: this.now(),
    });
    await this.audit('sweep.manual', sweep, { reason });
    this.deps.logger.error(
      { sweepId: sweep.id, reason },
      'sweep requer intervencao manual',
    );
    await this.deps.alerts?.send({
      level: 'warn',
      title: 'sweep requer intervencao manual',
      message: reason,
      metadata: {
        sweepId: sweep.id,
        intentId: sweep.intentId,
        amountSats: sweep.amountSats.toString(),
        txid: sweep.txid,
      },
    });
  }

  private async audit(
    action: string,
    sweep: Pick<OnchainSweep, 'id' | 'intentId' | 'addressId'>,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.repos.insertAuditEvent({
      actor: 'worker',
      action,
      entity: 'onchain_sweep',
      entityId: sweep.id,
      metadata: {
        sweepId: sweep.id,
        intentId: sweep.intentId,
        addressId: sweep.addressId,
        ...metadata,
      },
    });
  }
}
