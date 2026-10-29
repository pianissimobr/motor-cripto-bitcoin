import type { AppConfig } from '../config.js';
import {
  isEsploraNotFound,
  type EsploraClient,
  type EsploraUtxo,
} from '../adapters/chain/esplora.js';
import type { Repositories } from '../db/repositories.js';
import type { OnchainPayment, OnchainSweep, PaymentIntent, SweepInput } from '../domain/types.js';
import type { Logger } from '../logger.js';
import { enqueueIntentEvent } from './intent-events.js';
import type { AlertService } from './alert-service.js';

export type OnchainWatcherDeps = {
  repos: Repositories;
  esplora: EsploraClient;
  config: AppConfig;
  logger: Logger;
  alerts?: AlertService;
  now?: () => Date;
};

export type OnchainCycleResult = {
  checked: number;
  paid: number;
  late: number;
  reorged: number;
  doublePaid: number;
  errors: number;
};

export class OnchainWatcher {
  constructor(private readonly deps: OnchainWatcherDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private requiredConfirmations(intent: PaymentIntent): number {
    return intent.amountSats >= this.deps.config.onchain.highValueSats
      ? this.deps.config.onchain.highValueConfirmations
      : this.deps.config.onchain.confirmations;
  }

  async runCycle(
    limit = this.deps.config.jobs.batchSize,
  ): Promise<OnchainCycleResult> {
    const now = this.now();
    const watching = await this.deps.repos.listWatchableOnchainIntents(
      now,
      limit,
    );
    const recovery = await this.deps.repos.listRecoveryIntents(now, limit);
    const seen = new Set(watching.map((intent) => intent.id));
    const intents = watching.concat(
      recovery.filter((intent) => !seen.has(intent.id)),
    );
    const result: OnchainCycleResult = {
      checked: intents.length,
      paid: 0,
      late: 0,
      reorged: 0,
      doublePaid: 0,
      errors: 0,
    };
    if (intents.length === 0) return result;

    const tip = await this.deps.esplora.getTipHeight();

    for (const intent of intents) {
      try {
        if (this.isRecovery(intent, now)) {
          await this.processRecovery(intent, tip);
        } else {
          await this.processIntent(intent, tip, result);
        }
      } catch (err) {
        result.errors++;
        this.deps.logger.error(
          { err, intentId: intent.id },
          'erro ao observar pagamento on-chain',
        );
      }
    }

    return result;
  }

  private async processIntent(
    intent: PaymentIntent,
    tip: number,
    result: OnchainCycleResult,
  ): Promise<void> {
    if (!intent.onchainAddressId) return;
    const address = await this.deps.repos.findHdAddressById(
      intent.onchainAddressId,
    );
    if (!address) return;

    // Le o estado anterior antes do upsert para distinguir
    // "confirmado -> mempool" (reorg) de um pagamento que ja nasceu na mempool.
    const previous = await this.deps.repos.listOnchainPaymentsForIntent(
      intent.id,
    );
    const utxos = await this.deps.esplora.getAddressUtxos(address.address);
    const required = this.requiredConfirmations(intent);
    const utxoMap = new Map(
      utxos.map((utxo) => [`${utxo.txid}:${utxo.vout}`, utxo]),
    );

    for (const utxo of utxos) {
      const confirmations = this.confirmationsFor(utxo, tip);
      await this.deps.repos.upsertOnchainPayment({
        intentId: intent.id,
        addressId: address.id,
        txid: utxo.txid,
        vout: utxo.vout,
        amountSats: BigInt(utxo.value),
        blockHeight: utxo.status.block_height ?? null,
        blockHash: utxo.status.block_hash ?? null,
        confirmations,
        status: utxo.status.confirmed ? 'confirmado' : 'mempool',
      });
    }

    if (utxos.length > 0 && address.status === 'alocada') {
      await this.deps.repos.markHdAddressUsed(address.id);
    }

    const watchSwept = this.withinPaidWindow(intent);
    const sweeps = await this.deps.repos.listSweepsForAddress(address.id);
    let sweptStillOurs = 0n;
    let realReorg = false;

    for (const payment of previous) {
      const trackSpent = payment.status === 'gasto' && watchSwept;
      if (
        payment.status !== 'mempool' &&
        payment.status !== 'confirmado' &&
        !trackSpent
      ) {
        continue;
      }
      const key = `${payment.txid}:${payment.vout}`;
      const utxo = utxoMap.get(key);
      if (
        utxo &&
        (payment.status === 'confirmado' || payment.status === 'gasto') &&
        !utxo.status.confirmed
      ) {
        await this.deps.repos.updateOnchainPaymentStatus({
          txid: payment.txid,
          vout: payment.vout,
          status: 'reorg',
          confirmations: 0,
          blockHeight: null,
          blockHash: null,
          forceFromGasto: payment.status === 'gasto',
        });
        realReorg = true;
        continue;
      }
      if (utxo) continue;

      const spentByUs = await this.spentByOurSweep(sweeps, payment);
      if (spentByUs && (await this.txExists(payment.txid))) {
        if (payment.status !== 'gasto') {
          await this.deps.repos.updateOnchainPaymentStatus({
            txid: payment.txid,
            vout: payment.vout,
            status: 'gasto',
            confirmations: payment.confirmations,
            blockHeight: payment.blockHeight,
            blockHash: payment.blockHash,
          });
        }
        sweptStillOurs += payment.amountSats;
        continue;
      }

      await this.deps.repos.updateOnchainPaymentStatus({
        txid: payment.txid,
        vout: payment.vout,
        status: 'reorg',
        confirmations: 0,
        blockHeight: null,
        blockHash: null,
        forceFromGasto: payment.status === 'gasto',
      });
      realReorg = true;
    }

    const total = utxos.reduce((acc, utxo) => acc + BigInt(utxo.value), 0n);
    const confirmed = utxos
      .filter((utxo) => this.confirmationsFor(utxo, tip) >= required)
      .reduce((acc, utxo) => acc + BigInt(utxo.value), 0n);

    if (intent.status === 'pago' || intent.status === 'pago_tardio') {
      if (confirmed >= intent.amountSats && intent.paidRail === 'lightning') {
        const updated = await this.deps.repos.addOnchainToLightningPaidIntent(
          intent.id,
          confirmed,
        );
        if (updated) {
          result.doublePaid++;
          this.deps.logger.warn(
            {
              intentId: intent.id,
              externalId: intent.externalId,
              onchainSats: confirmed.toString(),
            },
            'pagamento duplicado: Lightning e on-chain; revisar estorno/excesso',
          );
          await this.deps.repos.insertAuditEvent({
            actor: 'worker',
            action: 'intent.double_paid',
            entity: 'payment_intent',
            entityId: intent.id,
            metadata: {
              externalId: intent.externalId,
              onchainSats: confirmed.toString(),
            },
          });
          await this.deps.alerts?.send({
            level: 'critical',
            title: 'pagamento duplicado (Lightning + on-chain)',
            metadata: {
              intentId: intent.id,
              externalId: intent.externalId,
              onchainSats: confirmed.toString(),
            },
          });
        }
      }

      if (realReorg && intent.paidRail !== 'lightning') {
        const lightning = await this.lightningPortion(intent);
        const custody = lightning + confirmed + sweptStillOurs;
        if (custody >= intent.amountSats) {
          if (intent.paidRail === 'both' && lightning >= intent.amountSats) {
            await this.deps.repos.revisePaidCustody({
              intentId: intent.id,
              paidRail: 'lightning',
              paidAmountSats: lightning,
              overpaidSats:
                lightning > intent.amountSats ? lightning - intent.amountSats : 0n,
            });
          }
        } else {
          const updated = await this.deps.repos.markIntentReorg(intent.id);
          if (updated) {
            result.reorged++;
            await enqueueIntentEvent(
              { repos: this.deps.repos, now: () => this.now() },
              updated,
              'payment_intent.reorged',
              'reorg',
            );
            await this.deps.repos.insertAuditEvent({
              actor: 'worker',
              action: 'intent.reorged',
              entity: 'payment_intent',
              entityId: updated.id,
              metadata: { externalId: updated.externalId },
            });
            await this.deps.alerts?.send({
              level: 'warn',
              title: 'reorg detectado em pagamento on-chain',
              metadata: {
                intentId: updated.id,
                externalId: updated.externalId,
              },
            });
          }
        }
      }
      return;
    }

    if (confirmed >= intent.amountSats) {
      const late =
        this.now().getTime() > intent.expiresAt.getTime() ||
        intent.status === 'expirado' ||
        intent.status === 'parcial';
      const status = late ? 'pago_tardio' : 'pago';
      const paidRail = intent.paidRail === 'lightning' ? 'both' : 'onchain';
      const overpaidSats =
        confirmed > intent.amountSats ? confirmed - intent.amountSats : 0n;

      const updated = await this.deps.repos.markIntentPaid({
        intentId: intent.id,
        status,
        paidRail,
        paidAmountSats: confirmed,
        overpaidSats,
        paidAt: this.now(),
      });
      if (!updated) return;

      if (late) result.late++;
      else result.paid++;

      await enqueueIntentEvent(
        { repos: this.deps.repos, now: () => this.now() },
        updated,
        late ? 'payment_intent.paid_late' : 'payment_intent.paid',
        'paid',
      );
      await this.deps.repos.insertAuditEvent({
        actor: 'worker',
        action: 'intent.paid_onchain',
        entity: 'payment_intent',
        entityId: updated.id,
        metadata: {
          externalId: updated.externalId,
          paidAmountSats: confirmed.toString(),
          confirmations: required,
          tip,
        },
      });
      this.deps.logger.info(
        {
          intentId: updated.id,
          externalId: updated.externalId,
          paidAmountSats: confirmed.toString(),
          late,
        },
        'pagamento on-chain confirmado',
      );
      return;
    }

    // Ha valor na mempool/parcial, mas ainda sem confirmacoes suficientes.
    // O job de expiracao decide entre aguardar, parcial ou expirado.
    if (total > 0n) {
      this.deps.logger.debug(
        {
          intentId: intent.id,
          totalSats: total.toString(),
          confirmedSats: confirmed.toString(),
          required,
        },
        'pagamento on-chain ainda sem confirmacoes suficientes',
      );
    }
  }

  private isRecovery(intent: PaymentIntent, now: Date): boolean {
    if (intent.status === 'cancelado') return true;
    if (intent.status !== 'expirado' && intent.status !== 'parcial') return false;
    return intent.graceUntil.getTime() <= now.getTime();
  }

  private withinPaidWindow(intent: PaymentIntent): boolean {
    if (intent.status !== 'pago' && intent.status !== 'pago_tardio') return false;
    if (!intent.paidAt) return false;
    return this.now().getTime() - intent.paidAt.getTime() <= 24 * 60 * 60 * 1000;
  }

  private async lightningPortion(intent: PaymentIntent): Promise<bigint> {
    if (intent.paidRail !== 'lightning' && intent.paidRail !== 'both') return 0n;
    if (!intent.lightningPaymentHash) return 0n;
    const payment = await this.deps.repos.findLightningPaymentByHash(
      intent.lightningPaymentHash,
    );
    if (!payment || payment.status !== 'pago') return 0n;
    return payment.amountSats;
  }

  private async spentByOurSweep(
    sweeps: OnchainSweep[],
    payment: OnchainPayment,
  ): Promise<boolean> {
    for (const sweep of sweeps) {
      if (!sweep.txid) continue;
      const inputs = sweep.inputs as SweepInput[];
      const matches = inputs.some(
        (input) => input.txid === payment.txid && input.vout === payment.vout,
      );
      if (!matches) continue;
      if (await this.txExists(sweep.txid)) return true;
    }
    return false;
  }

  private async txExists(txid: string): Promise<boolean> {
    try {
      await this.deps.esplora.getTx(txid);
      return true;
    } catch (err) {
      if (isEsploraNotFound(err)) return false;
      throw err;
    }
  }

  private async processRecovery(intent: PaymentIntent, tip: number): Promise<void> {
    if (!intent.onchainAddressId) return;
    const address = await this.deps.repos.findHdAddressById(
      intent.onchainAddressId,
    );
    if (!address) return;
    await this.deps.repos.touchIntent(intent.id);
    const previous = await this.deps.repos.listOnchainPaymentsForIntent(intent.id);
    const known = new Set(previous.map((payment) => `${payment.txid}:${payment.vout}`));
    const utxos = await this.deps.esplora.getAddressUtxos(address.address);
    for (const utxo of utxos) {
      const key = `${utxo.txid}:${utxo.vout}`;
      await this.deps.repos.upsertOnchainPayment({
        intentId: intent.id,
        addressId: address.id,
        txid: utxo.txid,
        vout: utxo.vout,
        amountSats: BigInt(utxo.value),
        blockHeight: utxo.status.block_height ?? null,
        blockHash: utxo.status.block_hash ?? null,
        confirmations: this.confirmationsFor(utxo, tip),
        status: utxo.status.confirmed ? 'confirmado' : 'mempool',
      });
      if (known.has(key)) continue;
      this.deps.logger.warn(
        { intentId: intent.id, txid: utxo.txid, vout: utxo.vout },
        'fundos fora do prazo no endereco da cobranca',
      );
      await this.deps.repos.insertAuditEvent({
        actor: 'worker',
        action: 'fundos_fora_do_prazo',
        entity: 'payment_intent',
        entityId: intent.id,
        metadata: {
          txid: utxo.txid,
          vout: utxo.vout,
          amountSats: String(utxo.value),
        },
      });
      await this.deps.alerts?.send({
        level: 'warn',
        title: 'fundos fora do prazo',
        metadata: {
          intentId: intent.id,
          externalId: intent.externalId,
          txid: utxo.txid,
          amountSats: String(utxo.value),
        },
      });
    }
  }

  private confirmationsFor(utxo: EsploraUtxo, tip: number): number {
    if (!utxo.status.confirmed || utxo.status.block_height === undefined) {
      return 0;
    }
    return Math.max(0, tip - utxo.status.block_height + 1);
  }
}
