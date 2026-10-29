import type { AppConfig } from '../config.js';
import type { EsploraClient, EsploraUtxo } from '../adapters/chain/esplora.js';
import type { Repositories } from '../db/repositories.js';
import type { PaymentIntent } from '../domain/types.js';
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
    const intents = await this.deps.repos.listWatchableOnchainIntents(
      now,
      limit,
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
        await this.processIntent(intent, tip, result);
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

    let reorgDetected = false;
    for (const payment of previous) {
      if (payment.status !== 'mempool' && payment.status !== 'confirmado') {
        continue;
      }
      const key = `${payment.txid}:${payment.vout}`;
      const utxo = utxoMap.get(key);
      if (!utxo) {
        await this.deps.repos.updateOnchainPaymentStatus({
          txid: payment.txid,
          vout: payment.vout,
          status: 'reorg',
          confirmations: 0,
          blockHeight: null,
          blockHash: null,
        });
        reorgDetected = true;
        continue;
      }
      if (payment.status === 'confirmado' && !utxo.status.confirmed) {
        // O UTXO continua na mempool, mas perdeu a confirmacao: reorg.
        await this.deps.repos.updateOnchainPaymentStatus({
          txid: payment.txid,
          vout: payment.vout,
          status: 'reorg',
          confirmations: 0,
          blockHeight: null,
          blockHash: null,
        });
        reorgDetected = true;
      }
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

      if (reorgDetected && confirmed < intent.amountSats) {
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
      return;
    }

    if (confirmed >= intent.amountSats) {
      const late =
        intent.status === 'expirado' || intent.status === 'parcial';
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

  private confirmationsFor(utxo: EsploraUtxo, tip: number): number {
    if (!utxo.status.confirmed || utxo.status.block_height === undefined) {
      return 0;
    }
    return Math.max(0, tip - utxo.status.block_height + 1);
  }
}
