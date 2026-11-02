import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import {
  assertPayoutTransition,
  brlCentsToUsdCents,
  decidePayout,
  usdcMinorToUsdCents,
} from '../domain/payout.js';
import { merchantAccountCode, PLATFORM_ACCOUNTS } from '../domain/ledger.js';
import type { Payout } from '../domain/types.js';
import type { LedgerService } from '../ledger/ledger-service.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';
import { enqueueSettlementEvent } from './intent-events.js';
import { enqueuePixChargeEvent } from './pix-events.js';
import type {
  UsdcPayoutAdapter,
  UsdcTransferResult,
} from '../adapters/payout/base-usdc.js';
import type { PixCharge } from '../domain/types.js';

export type PayoutServiceDeps = {
  repos: Repositories;
  ledger: LedgerService;
  adapter: UsdcPayoutAdapter;
  config: AppConfig;
  logger: Logger;
  alerts?: AlertService;
  now?: () => Date;
};

export type PayoutCycleResult = {
  created: number;
  automatic: number;
  manualApproval: number;
  retained: number;
  sent: number;
  confirmed: number;
  failed: number;
  manual: number;
  errors: number;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export class PayoutService {
  constructor(private readonly deps: PayoutServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async runCycle(
    limit = this.deps.config.jobs.batchSize,
  ): Promise<PayoutCycleResult> {
    const created = await this.createPayouts(limit);
    const pixCreated = await this.createPixPayouts(limit);
    const sent = await this.sendApproved(limit);
    const confirmed = await this.monitor(limit);
    return {
      created: created.created + pixCreated.created,
      automatic: created.automatic + pixCreated.automatic,
      manualApproval: created.manualApproval + pixCreated.manualApproval,
      retained: created.retained + pixCreated.retained,
      sent: sent.sent,
      confirmed: confirmed.confirmed,
      failed: confirmed.failed + sent.failed,
      manual: sent.manual,
      errors: created.errors + pixCreated.errors + sent.errors + confirmed.errors,
    };
  }

  async createPayouts(limit: number): Promise<{
    created: number;
    automatic: number;
    manualApproval: number;
    retained: number;
    errors: number;
  }> {
    const result = {
      created: 0,
      automatic: 0,
      manualApproval: 0,
      retained: 0,
      errors: 0,
    };
    const conversions =
      await this.deps.repos.listConvertedConversionsAwaitingPayout(limit);
    const now = this.now();

    for (const conversion of conversions) {
      try {
        const existing = await this.deps.repos.findPayoutByConversionId(
          conversion.id,
        );
        if (existing) continue;
        const amountMinor = conversion.targetAmountMinor;
        if (!amountMinor || amountMinor <= 0n) continue;

        const wallet =
          await this.deps.repos.findActiveUsdcSettlementWalletForClient(
            conversion.merchantId,
          );
        if (!wallet) {
          await this.deps.repos.updateIntentSettlement({
            intentId: conversion.intentId,
            from: ['convertido'],
            to: 'manual',
            conversionOrderId: conversion.id,
          });
          await this.deps.alerts?.send({
            level: 'error',
            title: 'loja sem carteira USDC para payout',
            message: 'conversao concluida sem carteira USDC de liquidacao',
            metadata: {
              conversionId: conversion.id,
              merchantId: conversion.merchantId,
            },
          });
          result.errors++;
          continue;
        }

        const client = await this.deps.repos.findClientById(
          conversion.merchantId,
        );
        if (!client) {
          result.errors++;
          continue;
        }
        if (
          client.payoutBatchSeconds > 0 &&
          this.now().getTime() <
            conversion.updatedAt.getTime() + client.payoutBatchSeconds * 1000
        ) {
          continue;
        }

        const amountUsdCents = usdcMinorToUsdCents(amountMinor);
        const dailyVolumeMinor = await this.deps.repos.sumPayoutMinorSince(
          conversion.merchantId,
          startOfUtcDay(this.now()),
        );
        const dailyVolumeUsdCents =
          dailyVolumeMinor / 10_000n;
        const dailyLimitUsdCents = brlCentsToUsdCents(
          client.unverifiedDailyLimitBrl,
          this.deps.config.payout.usdBrlCents,
        );
        const newWallet =
          this.now().getTime() - wallet.createdAt.getTime() <
          this.deps.config.payout.newWalletCareSeconds * 1000;
        const decision = decidePayout({
          amountUsdCents,
          autoPayoutLimitUsdCents: client.autoPayoutLimitUsd,
          dailyVolumeUsdCents,
          dailyLimitUsdCents,
          newWallet,
        });

        const status =
          decision === 'automatico'
            ? 'aprovado'
            : decision === 'aprovacao_manual'
              ? 'pendente'
              : 'retido';
        const lastError =
          decision === 'retido'
            ? newWallet
              ? 'carteira USDC nova em carencia de 24h'
              : 'limite diario de exposicao excedido'
            : null;

        const payout = await this.deps.repos.createPayout({
          merchantId: conversion.merchantId,
          walletId: wallet.id,
          amountMinor,
          idempotencyKey: `conversion:${conversion.id}`,
          conversionId: conversion.id,
          destinationAddress: wallet.address,
          status,
          ...(lastError ? { lastError } : {}),
          ...(decision === 'automatico' ? { approvedBy: 'automatico' } : {}),
        });

        await this.deps.repos.updateIntentSettlement({
          intentId: conversion.intentId,
          from: ['convertido'],
          to: decision === 'retido' ? 'manual' : 'payout_pendente',
          payoutId: payout.id,
        });
        await this.deps.repos.insertAuditEvent({
          actor: 'worker',
          action: 'payout.created',
          entity: 'payout',
          entityId: payout.id,
          metadata: {
            conversionId: conversion.id,
            amountMinor: amountMinor.toString(),
            amountUsdCents: amountUsdCents.toString(),
            decision,
          },
        });
        await this.enqueuePayoutEvent(payout, 'payment_intent.payout_pending', 'pending', {
          decision,
          destination_address: payout.destinationAddress,
        });

        result.created++;
        if (decision === 'automatico') result.automatic++;
        else if (decision === 'aprovacao_manual') result.manualApproval++;
        else result.retained++;
        this.deps.logger.info(
          {
            payoutId: payout.id,
            conversionId: conversion.id,
            amountMinor: amountMinor.toString(),
            decision,
          },
          'payout criado',
        );
      } catch (err) {
        result.errors++;
        this.deps.logger.error(
          { err, conversionId: conversion.id },
          'erro ao criar payout',
        );
      }
    }
    return result;
  }

  async createPixPayouts(limit: number): Promise<{
    created: number;
    automatic: number;
    manualApproval: number;
    retained: number;
    errors: number;
  }> {
    const result = {
      created: 0,
      automatic: 0,
      manualApproval: 0,
      retained: 0,
      errors: 0,
    };
    const charges = await this.deps.repos.listPixChargesAwaitingPayout(limit);
    const now = this.now();

    for (const charge of charges) {
      try {
        const existing = await this.deps.repos.findPayoutByPixChargeId(charge.id);
        if (existing) continue;
        const amountMinor = charge.assetAmountMinor;
        if (!amountMinor || amountMinor <= 0n) continue;

        const wallet =
          await this.deps.repos.findActiveUsdcSettlementWalletForClient(
            charge.clientId,
          );
        if (!wallet) {
          await this.deps.repos.updatePixCharge({
            id: charge.id,
            settlementStatus: 'manual',
            error: 'loja sem carteira USDC para payout',
          });
          await this.deps.alerts?.send({
            level: 'error',
            title: 'loja sem carteira USDC para payout PIX',
            message: 'liquidacao PIX concluida sem carteira USDC de liquidacao',
            metadata: { pixChargeId: charge.id, clientId: charge.clientId },
          });
          result.errors++;
          continue;
        }

        const client = await this.deps.repos.findClientById(charge.clientId);
        if (!client) {
          result.errors++;
          continue;
        }
        if (
          client.payoutBatchSeconds > 0 &&
          this.now().getTime() <
            charge.updatedAt.getTime() + client.payoutBatchSeconds * 1000
        ) {
          continue;
        }

        const amountUsdCents = usdcMinorToUsdCents(amountMinor);
        const dailyVolumeMinor = await this.deps.repos.sumPayoutMinorSince(
          charge.clientId,
          startOfUtcDay(this.now()),
        );
        const dailyVolumeUsdCents = dailyVolumeMinor / 10_000n;
        const dailyLimitUsdCents = brlCentsToUsdCents(
          client.unverifiedDailyLimitBrl,
          this.deps.config.payout.usdBrlCents,
        );
        const newWallet =
          this.now().getTime() - wallet.createdAt.getTime() <
          this.deps.config.payout.newWalletCareSeconds * 1000;
        const decision = decidePayout({
          amountUsdCents,
          autoPayoutLimitUsdCents: client.autoPayoutLimitUsd,
          dailyVolumeUsdCents,
          dailyLimitUsdCents,
          newWallet,
        });

        const status =
          decision === 'automatico'
            ? 'aprovado'
            : decision === 'aprovacao_manual'
              ? 'pendente'
              : 'retido';
        const lastError =
          decision === 'retido'
            ? newWallet
              ? 'carteira USDC nova em carencia de 24h'
              : 'limite diario de exposicao excedido'
            : null;

        const payout = await this.deps.repos.createPayout({
          merchantId: charge.clientId,
          walletId: wallet.id,
          amountMinor,
          idempotencyKey: `pix:${charge.id}`,
          pixChargeId: charge.id,
          destinationAddress: wallet.address,
          status,
          ...(lastError ? { lastError } : {}),
          ...(decision === 'automatico' ? { approvedBy: 'automatico' } : {}),
        });

        await this.deps.repos.updatePixCharge({
          id: charge.id,
          payoutId: payout.id,
          settlementStatus: decision === 'retido' ? 'manual' : 'payout_pendente',
        });
        await this.deps.repos.insertAuditEvent({
          actor: 'worker',
          action: 'pix_payout.created',
          entity: 'payout',
          entityId: payout.id,
          metadata: {
            pixChargeId: charge.id,
            amountMinor: amountMinor.toString(),
            amountUsdCents: amountUsdCents.toString(),
            decision,
          },
        });
        await enqueuePixChargeEvent(
          { repos: this.deps.repos, now: () => this.now() },
          { ...charge, payoutId: payout.id } as PixCharge,
          'pix_charge.payout_pending',
          'pending',
        );

        result.created++;
        if (decision === 'automatico') result.automatic++;
        else if (decision === 'aprovacao_manual') result.manualApproval++;
        else result.retained++;
        this.deps.logger.info(
          {
            payoutId: payout.id,
            pixChargeId: charge.id,
            amountMinor: amountMinor.toString(),
            decision,
          },
          'payout de PIX criado',
        );
      } catch (err) {
        result.errors++;
        this.deps.logger.error(
          { err, pixChargeId: charge.id },
          'erro ao criar payout de PIX',
        );
      }
    }
    return result;
  }

  async sendApproved(limit: number): Promise<{
    sent: number;
    failed: number;
    manual: number;
    errors: number;
  }> {
    const result = { sent: 0, failed: 0, manual: 0, errors: 0 };
    const payouts = await this.deps.repos.listPayoutsToSend(limit);
    for (const payout of payouts) {
      try {
        if (!payout.destinationAddress) {
          await this.fail(payout, 'payout sem destino USDC');
          result.failed++;
          continue;
        }
        const wallet = payout.walletId
          ? await this.deps.repos.findMerchantWalletById(payout.walletId)
          : null;
        if (
          !wallet ||
          wallet.status !== 'ativo' ||
          wallet.kind !== 'usdc_settlement' ||
          wallet.address.toLowerCase() !== payout.destinationAddress.toLowerCase()
        ) {
          await this.fail(payout, 'carteira USDC allowlisted indisponivel');
          result.failed++;
          continue;
        }

        try {
          const gas = await this.deps.adapter.getGasBalanceWei();
          if (gas < this.deps.config.payout.minGasWei) {
            await this.deps.repos.updatePayout({
              id: payout.id,
              status: 'retido',
              lastError: 'gas ETH insuficiente na Base',
            });
            await this.deps.alerts?.send({
              level: 'warn',
              title: 'gas ETH insuficiente para payout',
              message: 'abasteca a carteira quente da Base',
              metadata: {
                payoutId: payout.id,
                gasWei: gas.toString(),
                minGasWei: this.deps.config.payout.minGasWei.toString(),
              },
            });
            result.manual++;
            continue;
          }
        } catch (err) {
          result.errors++;
          this.deps.logger.warn(
            { err, payoutId: payout.id },
            'falha ao checar gas; payout fica para o proximo ciclo',
          );
          continue;
        }

        const claimed = await this.deps.repos.claimPayoutForSending(payout.id);
        if (!claimed) {
          this.deps.logger.debug(
            { payoutId: payout.id },
            'payout ja reivindicado por outro worker',
          );
          continue;
        }
        const sent = await this.deps.adapter.transfer({
          to: payout.destinationAddress,
          amountMinor: payout.amountMinor,
          idempotencyKey: payout.idempotencyKey,
        });
        if (sent.kind === 'manual') {
          await this.deps.repos.updatePayout({
            id: payout.id,
            status: 'retido',
            lastError: sent.reason,
          });
          result.manual++;
          continue;
        }
        await this.applyTransfer(payout, sent);
        result.sent++;
      } catch (err) {
        result.errors++;
        await this.fail(payout, errorMessage(err));
      }
    }
    return result;
  }

  async monitor(limit: number): Promise<{
    confirmed: number;
    failed: number;
    errors: number;
  }> {
    const result = { confirmed: 0, failed: 0, errors: 0 };
    const payouts = await this.deps.repos.listPayoutsToMonitor(limit);
    for (const payout of payouts) {
      try {
        if (!payout.txid) {
          await this.fail(payout, 'payout em envio sem txid');
          result.failed++;
          continue;
        }
        const confirmation = await this.deps.adapter.getConfirmation(
          payout.txid,
        );
        if (confirmation.reverted) {
          await this.deps.repos.updatePayout({
            id: payout.id,
            status: 'falhou',
            lastError: 'transacao USDC revertida na Base',
          });
          await this.postReversed(payout);
          await this.markReversal(payout, 'transacao USDC revertida na Base');
          await this.enqueuePayoutEvent(
            payout,
            'payment_intent.payout_failed',
            'failed',
            { txid: payout.txid, reason: 'transacao revertida' },
          );
          result.failed++;
          continue;
        }
        if (!confirmation.confirmed) continue;

        await this.deps.repos.updatePayout({
          id: payout.id,
          status: 'confirmado',
          confirmedAt: this.now(),
          lastError: null,
        });
        await this.postConfirmed(payout);
        await this.markSettlement(
          payout,
          ['payout_pendente', 'convertido'],
          'pago',
        );
        await this.deps.repos.insertAuditEvent({
          actor: 'worker',
          action: 'payout.confirmed',
          entity: 'payout',
          entityId: payout.id,
          metadata: {
            txid: payout.txid,
            amountMinor: payout.amountMinor.toString(),
            blockNumber: confirmation.blockNumber?.toString() ?? null,
          },
        });
        await this.enqueuePayoutEvent(
          payout,
          'payment_intent.payout_confirmed',
          'confirmed',
          {
            txid: payout.txid,
            block_number: confirmation.blockNumber?.toString() ?? null,
          },
        );
        result.confirmed++;
        this.deps.logger.info(
          { payoutId: payout.id, txid: payout.txid },
          'payout USDC confirmado',
        );
      } catch (err) {
        result.errors++;
        this.deps.logger.error(
          { err, payoutId: payout.id },
          'erro ao monitorar payout',
        );
      }
    }
    return result;
  }

  async approve(id: string, actor: string): Promise<Payout> {
    const payout = await this.deps.repos.findPayoutById(id);
    if (!payout) throw new Error('payout nao encontrado');
    assertPayoutTransition(payout.status, 'aprovado');
    const updated = await this.deps.repos.updatePayout({
      id,
      status: 'aprovado',
      approvedBy: actor,
      lastError: null,
    });
    if (!updated) throw new Error('falha ao aprovar payout');
    await this.deps.repos.insertAuditEvent({
      actor,
      action: 'payout.approved',
      entity: 'payout',
      entityId: id,
      metadata: { amountMinor: payout.amountMinor.toString() },
    });
    await this.reopenSettlement(payout);
    return updated;
  }

  async retry(id: string, actor: string): Promise<Payout> {
    const payout = await this.deps.repos.findPayoutById(id);
    if (!payout) throw new Error('payout nao encontrado');
    if (payout.status !== 'falhou' && payout.status !== 'retido') {
      throw new Error(`payout nao pode ser reenviado no status ${payout.status}`);
    }
    assertPayoutTransition(payout.status, 'aprovado');
    const updated = await this.deps.repos.updatePayout({
      id,
      status: 'aprovado',
      approvedBy: actor,
      lastError: null,
    });
    if (!updated) throw new Error('falha ao reenviar payout');
    await this.deps.repos.insertAuditEvent({
      actor,
      action: 'payout.retry',
      entity: 'payout',
      entityId: id,
      metadata: { previousStatus: payout.status },
    });
    await this.reopenSettlement(payout);
    return updated;
  }

  private async reopenSettlement(payout: Payout): Promise<void> {
    if (payout.pixChargeId) {
      await this.deps.repos.updatePixCharge({
        id: payout.pixChargeId,
        settlementStatus: 'payout_pendente',
      });
      return;
    }
    if (!payout.conversionId) return;
    const conversion = await this.deps.repos.findConversionOrderById(
      payout.conversionId,
    );
    if (!conversion) return;
    await this.deps.repos.updateIntentSettlement({
      intentId: conversion.intentId,
      from: ['manual', 'convertido', 'payout_pendente'],
      to: 'payout_pendente',
      payoutId: payout.id,
    });
  }

  private async applyTransfer(
    payout: Payout,
    sent: Extract<UsdcTransferResult, { kind: 'sent' }>,
  ): Promise<void> {
    await this.deps.repos.updatePayout({
      id: payout.id,
      status: 'enviando',
      txid: sent.txid,
      sentAt: this.now(),
      lastError: null,
    });
    await this.deps.ledger.postTransaction({
      kind: 'payout_initiated',
      referenceType: 'payout',
      referenceId: payout.id,
      entries: [
        {
          accountCode: merchantAccountCode(payout.merchantId, 'usdc_available'),
          merchantId: payout.merchantId,
          asset: 'USDC',
          debitMinor: payout.amountMinor,
        },
        {
          accountCode: merchantAccountCode(
            payout.merchantId,
            'payout_in_transit',
          ),
          merchantId: payout.merchantId,
          asset: 'USDC',
          creditMinor: payout.amountMinor,
        },
      ],
    });
    await this.deps.repos.insertAuditEvent({
      actor: 'worker',
      action: 'payout.sent',
      entity: 'payout',
      entityId: payout.id,
      metadata: {
        txid: sent.txid,
        amountMinor: payout.amountMinor.toString(),
      },
    });
    await this.enqueuePayoutEvent(payout, 'payment_intent.payout_sent', 'sent', {
      txid: sent.txid,
    });
  }

  private async postConfirmed(payout: Payout): Promise<void> {
    await this.deps.ledger.postTransaction({
      kind: 'payout_confirmed',
      referenceType: 'payout',
      referenceId: payout.id,
      entries: [
        {
          accountCode: merchantAccountCode(
            payout.merchantId,
            'payout_in_transit',
          ),
          merchantId: payout.merchantId,
          asset: 'USDC',
          debitMinor: payout.amountMinor,
        },
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryUsdc,
          asset: 'USDC',
          creditMinor: payout.amountMinor,
        },
      ],
    });
  }

  private async postReversed(payout: Payout): Promise<void> {
    await this.deps.ledger.postTransaction({
      kind: 'payout_reversed',
      referenceType: 'payout',
      referenceId: payout.id,
      entries: [
        {
          accountCode: merchantAccountCode(
            payout.merchantId,
            'payout_in_transit',
          ),
          merchantId: payout.merchantId,
          asset: 'USDC',
          debitMinor: payout.amountMinor,
        },
        {
          accountCode: merchantAccountCode(payout.merchantId, 'usdc_available'),
          merchantId: payout.merchantId,
          asset: 'USDC',
          creditMinor: payout.amountMinor,
        },
      ],
    });
  }

  private async markReversal(payout: Payout, reason: string): Promise<void> {
    if (payout.pixChargeId) {
      await this.deps.repos.updatePixCharge({
        id: payout.pixChargeId,
        status: 'manual',
        settlementStatus: 'manual',
        error: reason,
      });
      await this.deps.alerts?.send({
        level: 'error',
        title: 'payout PIX revertido',
        message: reason,
        metadata: { payoutId: payout.id, pixChargeId: payout.pixChargeId },
      });
      return;
    }
    await this.markSettlement(
      payout,
      ['payout_pendente', 'convertido'],
      'falhou',
    );
  }

  private async markSettlement(
    payout: Payout,
    from: Array<'convertido' | 'payout_pendente'>,
    to: 'pago' | 'falhou',
  ): Promise<void> {
    if (payout.pixChargeId) {
      await this.deps.repos.updatePixCharge({
        id: payout.pixChargeId,
        settlementStatus: to,
        error: to === 'falhou' ? 'payout PIX falhou' : null,
      });
      return;
    }
    const conversion = payout.conversionId
      ? await this.deps.repos.findConversionOrderById(payout.conversionId)
      : null;
    if (!conversion) return;
    await this.deps.repos.updateIntentSettlement({
      intentId: conversion.intentId,
      from,
      to,
      payoutId: payout.id,
    });
  }

  private async fail(payout: Payout, reason: string): Promise<void> {
    await this.deps.repos.updatePayout({
      id: payout.id,
      status: 'falhou',
      lastError: reason,
    });
    await this.deps.repos.insertAuditEvent({
      actor: 'worker',
      action: 'payout.failed',
      entity: 'payout',
      entityId: payout.id,
      metadata: { reason },
    });
    await this.deps.alerts?.send({
      level: 'error',
      title: 'payout USDC falhou',
      message: reason,
      metadata: { payoutId: payout.id },
    });
    await this.enqueuePayoutEvent(payout, 'payment_intent.payout_failed', 'failed', {
      reason,
    });
  }

  private async enqueuePayoutEvent(
    payout: Payout,
    eventType:
      | 'payment_intent.payout_pending'
      | 'payment_intent.payout_sent'
      | 'payment_intent.payout_confirmed'
      | 'payment_intent.payout_failed',
    suffix: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (payout.pixChargeId) {
      const charge = await this.deps.repos.findPixChargeById(payout.pixChargeId);
      if (!charge) return;
      const pixEventType = eventType.replace(
        'payment_intent.',
        'pix_charge.',
      ) as
        | 'pix_charge.payout_pending'
        | 'pix_charge.payout_sent'
        | 'pix_charge.payout_confirmed'
        | 'pix_charge.payout_failed';
      await enqueuePixChargeEvent(
        { repos: this.deps.repos, now: () => this.now() },
        charge,
        pixEventType,
        `payout:${payout.id}:${suffix}`,
      );
      return;
    }
    if (!payout.conversionId) return;
    const conversion = await this.deps.repos.findConversionOrderById(
      payout.conversionId,
    );
    if (!conversion) return;
    await enqueueSettlementEvent(
      { repos: this.deps.repos, now: () => this.now() },
      {
        intentId: conversion.intentId,
        eventType,
        dedupeSuffix: `payout:${payout.id}:${suffix}`,
        data: {
          payout_id: payout.id,
          conversion_id: payout.conversionId,
          amount_minor: payout.amountMinor.toString(),
          ...data,
        },
      },
    );
  }
}
