import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import type { LightningTreasuryWithdrawal } from '../adapters/conversion/lnbits-withdrawal.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';

export type TreasuryServiceDeps = {
  repos: Repositories;
  withdrawal: LightningTreasuryWithdrawal;
  config: AppConfig;
  logger: Logger;
  alerts?: AlertService;
};

export type TreasuryCycleResult = {
  checked: number;
  withdrawn: number;
  manual: number;
  skipped: number;
  errors: number;
};

/**
 * Move o saldo Lightning da LNbits para a treasury BTC antes da conversao.
 * O endpoint de saque e um bridge HTTP; quando ausente, o pedido fica manual.
 */
export class TreasuryService {
  constructor(private readonly deps: TreasuryServiceDeps) {}

  async runCycle(
    limit = this.deps.config.jobs.batchSize,
  ): Promise<TreasuryCycleResult> {
    const result: TreasuryCycleResult = {
      checked: 0,
      withdrawn: 0,
      manual: 0,
      skipped: 0,
      errors: 0,
    };
    const treasuryAddress =
      this.deps.config.treasury.btcAddress ??
      this.deps.config.sweep.coldWalletAddress;
    if (!treasuryAddress) {
      return result;
    }

    const intents = await this.deps.repos.listPaidLightningIntentsForTreasury(limit);
    for (const intent of intents) {
      result.checked++;
      try {
        const externalId = `lnbits-withdrawal:${intent.id}`;
        if (await this.deps.repos.hasProviderEvent('lnbits', externalId)) {
          result.skipped++;
          continue;
        }
        if (!intent.lightningPaymentHash) {
          result.skipped++;
          continue;
        }
        const amountSats = intent.paidAmountSats ?? intent.amountSats;
        const withdrawal = await this.deps.withdrawal.withdraw({
          intentId: intent.id,
          paymentHash: intent.lightningPaymentHash,
          amountSats,
          address: treasuryAddress,
          memo: `treasury ${intent.externalId}`.slice(0, 100),
        });

        if (withdrawal.kind === 'manual') {
          await this.deps.repos.insertProviderEvent({
            provider: 'lnbits',
            eventType: 'withdrawal_manual',
            externalId,
            payload: {
              reason: withdrawal.reason,
              intentId: intent.id,
              amountSats: amountSats.toString(),
            },
          });
          result.manual++;
          await this.deps.repos.insertAuditEvent({
            actor: 'worker',
            action: 'treasury.lightning_withdrawal_manual',
            entity: 'payment_intent',
            entityId: intent.id,
            metadata: { reason: withdrawal.reason },
          });
          await this.deps.alerts?.send({
            level: 'warn',
            title: 'saque Lightning para treasury manual',
            message: withdrawal.reason,
            metadata: { intentId: intent.id, amountSats: amountSats.toString() },
          });
          continue;
        }

        await this.deps.repos.insertProviderEvent({
          provider: 'lnbits',
          eventType: 'withdrawal_sent',
          externalId,
          payload: {
            txid: withdrawal.txid,
            providerRef: withdrawal.providerRef,
            intentId: intent.id,
            amountSats: amountSats.toString(),
          },
        });
        await this.deps.repos.insertAuditEvent({
          actor: 'worker',
          action: 'treasury.lightning_withdrawal_sent',
          entity: 'payment_intent',
          entityId: intent.id,
          metadata: {
            txid: withdrawal.txid,
            amountSats: amountSats.toString(),
          },
        });
        result.withdrawn++;
      } catch (err) {
        result.errors++;
        this.deps.logger.error(
          { err, intentId: intent.id },
          'erro no saque Lightning para treasury',
        );
      }
    }
    return result;
  }
}
