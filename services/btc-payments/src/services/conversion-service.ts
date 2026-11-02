import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import { PLATFORM_ACCOUNTS, merchantAccountCode } from '../domain/ledger.js';
import type {
  ConversionOrder,
  PaymentIntent,
} from '../domain/types.js';
import type { LedgerService } from '../ledger/ledger-service.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';
import { enqueueSettlementEvent } from './intent-events.js';
import type {
  SwapQuoteProvider,
  SwapStatus,
} from '../adapters/conversion/thorchain.js';
import type {
  TreasuryBtcSender,
  TreasuryBtcSendResult,
} from '../adapters/conversion/btc-treasury.js';

export type ConversionServiceDeps = {
  repos: Repositories;
  ledger: LedgerService;
  swap: SwapQuoteProvider;
  sender: TreasuryBtcSender;
  config: AppConfig;
  logger: Logger;
  alerts?: AlertService;
  now?: () => Date;
};

export type ConversionCycleResult = {
  created: number;
  quoted: number;
  sent: number;
  converted: number;
  refunded: number;
  failed: number;
  manual: number;
  monitored: number;
  errors: number;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ConversionService {
  constructor(private readonly deps: ConversionServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async retry(id: string): Promise<ConversionOrder> {
    const order = await this.deps.repos.findConversionOrderById(id);
    if (!order) throw new Error('conversao nao encontrada');
    if (order.status !== 'falhou' && order.status !== 'manual') {
      throw new Error(`conversao nao pode ser reenviada no status ${order.status}`);
    }
    const updated = await this.deps.repos.updateConversionOrder({
      id,
      status: 'criada',
      providerOrderId: null,
      inboundAddress: null,
      memo: null,
      quoteExpiresAt: null,
      providerPayload: null,
      error: null,
      attempts: 0,
    });
    if (!updated) throw new Error('falha ao reenfileirar conversao');
    await this.deps.repos.updateIntentSettlement({
      intentId: order.intentId,
      from: ['manual', 'falhou', 'convertido'],
      to: 'convertendo',
      conversionOrderId: order.id,
    });
    await this.deps.repos.insertAuditEvent({
      actor: 'admin',
      action: 'conversion.retry',
      entity: 'conversion_order',
      entityId: id,
      metadata: { previousStatus: order.status },
    });
    return updated;
  }

  async runCycle(
    limit = this.deps.config.jobs.batchSize,
  ): Promise<ConversionCycleResult> {
    const created = await this.createOrders(limit);
    const quoted = await this.quoteOrders(limit);
    const sent = await this.sendOrders(limit);
    const polled = await this.pollOrders(limit);
    return {
      created: created.created,
      quoted: quoted.quoted,
      sent: sent.sent,
      converted: polled.converted,
      refunded: polled.refunded,
      failed: created.failed + quoted.failed + sent.failed + polled.failed,
      manual: created.manual + quoted.manual + sent.manual + polled.manual,
      monitored: polled.monitored,
      errors:
        created.errors + quoted.errors + sent.errors + polled.errors,
    };
  }

  async createOrders(limit: number): Promise<{
    created: number;
    manual: number;
    failed: number;
    errors: number;
  }> {
    const result = { created: 0, manual: 0, failed: 0, errors: 0 };
    const intents = await this.deps.repos.listIntentsAwaitingConversion(limit);
    for (const intent of intents) {
      try {
        const amountSats = intent.paidAmountSats ?? intent.amountSats;
        if (amountSats <= 0n) {
          result.errors++;
          continue;
        }
        const order = await this.deps.repos.createConversionOrder({
          merchantId: intent.clientId,
          intentId: intent.id,
          sourceAmountSats: amountSats,
          provider: 'thorchain',
          ...(intent.fxQuoteId ? { fxQuoteId: intent.fxQuoteId } : {}),
        });
        await this.postPaymentReceived(intent, amountSats);

        if (amountSats < this.deps.config.conversion.minSats) {
          await this.deps.repos.updateConversionOrder({
            id: order.id,
            status: 'manual',
            error: `valor abaixo do minimo economico (${this.deps.config.conversion.minSats.toString()} sats)`,
          });
          await this.deps.repos.updateIntentSettlement({
            intentId: intent.id,
            from: ['nao_iniciado', 'aguardando_confirmacao', 'pronto_para_conversao'],
            to: 'manual',
            conversionOrderId: order.id,
          });
          await this.deps.repos.insertAuditEvent({
            actor: 'worker',
            action: 'conversion.below_minimum',
            entity: 'conversion_order',
            entityId: order.id,
            metadata: {
              intentId: intent.id,
              amountSats: amountSats.toString(),
            },
          });
          result.manual++;
          continue;
        }

        await this.deps.repos.updateIntentSettlement({
          intentId: intent.id,
          from: ['nao_iniciado', 'aguardando_confirmacao', 'pronto_para_conversao'],
          to: 'convertendo',
          conversionOrderId: order.id,
        });
        result.created++;
      } catch (err) {
        result.errors++;
        this.deps.logger.error(
          { err, intentId: intent.id },
          'erro ao criar ordem de conversao',
        );
      }
    }
    return result;
  }

  async quoteOrders(limit: number): Promise<{
    quoted: number;
    manual: number;
    failed: number;
    errors: number;
  }> {
    const result = { quoted: 0, manual: 0, failed: 0, errors: 0 };
    const orders = await this.deps.repos.listConversionOrdersToQuote(limit);
    for (const order of orders) {
      try {
        const targetWallet =
          await this.deps.repos.findActiveUsdcSettlementWalletForClient(
            order.merchantId,
          );
        if (!targetWallet) {
          await this.markManual(order, 'loja sem carteira USDC de liquidacao');
          result.manual++;
          continue;
        }
        const refundAddress =
          this.deps.config.treasury.btcAddress ??
          this.deps.config.sweep.coldWalletAddress;
        if (!refundAddress) {
          await this.markManual(order, 'treasury BTC/refund ausente');
          result.manual++;
          continue;
        }

        await this.deps.repos.updateConversionOrder({
          id: order.id,
          status: 'cotando',
          error: null,
        });
        const quote = await this.deps.swap.quote({
          sourceAmountSats: order.sourceAmountSats,
          targetAddress: targetWallet.address,
          refundAddress,
          slippageBps: this.deps.config.conversion.slippageBps,
        });
        if (quote.expiresAt.getTime() <= this.now().getTime()) {
          throw new Error('quote THORChain expirada antes do envio');
        }

        await this.deps.repos.updateConversionOrder({
          id: order.id,
          status: 'enviando_btc',
          targetAmountMinor: quote.expectedAmountOutMinor,
          providerOrderId: quote.providerOrderId,
          inboundAddress: quote.inboundAddress,
          memo: quote.memo,
          quoteExpiresAt: quote.expiresAt,
          providerPayload: quote.raw,
          error: null,
        });
        await this.deps.repos.upsertConversionLeg({
          conversionId: order.id,
          leg: 'thorchain',
          provider: quote.provider,
          status: 'pendente',
          providerRef: quote.providerOrderId,
          amountIn: order.sourceAmountSats,
        });
        result.quoted++;
        this.deps.logger.info(
          {
            conversionId: order.id,
            expectedAmountOutMinor: quote.expectedAmountOutMinor.toString(),
            inboundAddress: quote.inboundAddress,
          },
          'quote THORChain criada',
        );
      } catch (err) {
        result.errors++;
        await this.handleQuoteFailure(order, err);
      }
    }
    return result;
  }

  async sendOrders(limit: number): Promise<{
    sent: number;
    manual: number;
    failed: number;
    errors: number;
  }> {
    const result = { sent: 0, manual: 0, failed: 0, errors: 0 };
    const orders = await this.deps.repos.listConversionOrdersToSend(limit);
    for (const order of orders) {
      try {
        if (!order.inboundAddress || !order.memo) {
          await this.markManual(order, 'quote sem inbound/memo');
          result.manual++;
          continue;
        }
        const refundAddress =
          this.deps.config.treasury.btcAddress ??
          this.deps.config.sweep.coldWalletAddress;
        if (!refundAddress) {
          await this.markManual(order, 'refund address ausente');
          result.manual++;
          continue;
        }
        if (
          order.quoteExpiresAt &&
          order.quoteExpiresAt.getTime() <= this.now().getTime()
        ) {
          await this.deps.repos.updateConversionOrder({
            id: order.id,
            status: 'criada',
            providerOrderId: null,
            inboundAddress: null,
            memo: null,
            quoteExpiresAt: null,
            providerPayload: null,
            error: 'quote expirada; recotando',
          });
          result.failed++;
          continue;
        }

        const sent = await this.deps.sender.send({
          conversionId: order.id,
          sourceAmountSats: order.sourceAmountSats,
          inboundAddress: order.inboundAddress,
          memo: order.memo,
          refundAddress,
        });
        await this.applySendResult(order, sent, result);
      } catch (err) {
        result.errors++;
        await this.handleSendFailure(order, err);
      }
    }
    return result;
  }

  async pollOrders(limit: number): Promise<{
    converted: number;
    refunded: number;
    failed: number;
    manual: number;
    monitored: number;
    errors: number;
  }> {
    const result = {
      converted: 0,
      refunded: 0,
      failed: 0,
      manual: 0,
      monitored: 0,
      errors: 0,
    };
    const orders = await this.deps.repos.listConversionOrdersToMonitor(limit);
    for (const order of orders) {
      result.monitored++;
      try {
        const txid = order.txids[0];
        if (!txid) {
          await this.markManual(order, 'ordem sem txid de envio BTC');
          result.manual++;
          continue;
        }
        const status = await this.deps.swap.getStatus(txid);
        await this.applyStatus(order, status, result);
      } catch (err) {
        result.errors++;
        this.deps.logger.error(
          { err, conversionId: order.id },
          'erro ao consultar status THORChain',
        );
      }
    }
    return result;
  }

  private async applySendResult(
    order: ConversionOrder,
    sent: TreasuryBtcSendResult,
    result: { sent: number; manual: number; failed: number },
  ): Promise<void> {
    if (sent.kind === 'manual') {
      await this.deps.repos.updateConversionOrder({
        id: order.id,
        status: 'manual',
        error: sent.reason,
      });
      await this.deps.repos.updateIntentSettlement({
        intentId: order.intentId,
        from: ['convertendo'],
        to: 'manual',
        conversionOrderId: order.id,
      });
      await this.deps.repos.upsertConversionLeg({
        conversionId: order.id,
        leg: 'thorchain',
        provider: order.provider,
        status: 'manual',
        providerRef: order.providerOrderId,
        amountIn: order.sourceAmountSats,
      });
      await this.deps.repos.insertAuditEvent({
        actor: 'worker',
        action: 'conversion.manual',
        entity: 'conversion_order',
        entityId: order.id,
        metadata: { reason: sent.reason },
      });
      result.manual++;
      return;
    }

    await this.deps.repos.updateConversionOrder({
      id: order.id,
      status: 'aguardando_swap',
      txids: [...order.txids, sent.txid],
      attempts: order.attempts + 1,
      error: null,
    });
    await this.deps.repos.upsertConversionLeg({
      conversionId: order.id,
      leg: 'thorchain',
      provider: order.provider,
      status: 'enviado',
      txid: sent.txid,
      providerRef: order.providerOrderId,
      amountIn: order.sourceAmountSats,
    });
    await this.deps.repos.insertAuditEvent({
      actor: 'worker',
      action: 'conversion.btc_sent',
      entity: 'conversion_order',
      entityId: order.id,
      metadata: {
        txid: sent.txid,
        amountSats: order.sourceAmountSats.toString(),
      },
    });
    result.sent++;
    this.deps.logger.info(
      { conversionId: order.id, txid: sent.txid },
      'BTC enviado para THORChain',
    );
  }

  private async applyStatus(
    order: ConversionOrder,
    status: SwapStatus,
    result: {
      converted: number;
      refunded: number;
      failed: number;
      manual: number;
    },
  ): Promise<void> {
    if (status.refunded) {
      await this.deps.repos.updateConversionOrder({
        id: order.id,
        status: 'reembolsada',
        error: 'THORChain reembolsou o BTC',
      });
      await this.deps.repos.updateIntentSettlement({
        intentId: order.intentId,
        from: ['convertendo'],
        to: 'manual',
        conversionOrderId: order.id,
      });
      await this.deps.repos.upsertConversionLeg({
        conversionId: order.id,
        leg: 'thorchain',
        provider: order.provider,
        status: 'falhou',
        txid: order.txids[0] ?? null,
        providerRef: status.outboundTxid,
      });
      await this.recordProviderEvent(order, 'refunded', status);
      await enqueueSettlementEvent(
        { repos: this.deps.repos, now: () => this.now() },
        {
          intentId: order.intentId,
          eventType: 'payment_intent.conversion_refunded',
          dedupeSuffix: `conversion:${order.id}:refunded`,
          data: {
            conversion_id: order.id,
            outbound_txid: status.outboundTxid,
          },
        },
      );
      result.refunded++;
      await this.deps.alerts?.send({
        level: 'warn',
        title: 'conversao THORChain reembolsada',
        message: `conversao ${order.id} reembolsada`,
        metadata: { conversionId: order.id, intentId: order.intentId },
      });
      return;
    }

    if (status.failed) {
      await this.deps.repos.updateConversionOrder({
        id: order.id,
        status: 'falhou',
        error: 'THORChain reportou falha',
      });
      await this.deps.repos.updateIntentSettlement({
        intentId: order.intentId,
        from: ['convertendo'],
        to: 'falhou',
        conversionOrderId: order.id,
      });
      await this.deps.repos.upsertConversionLeg({
        conversionId: order.id,
        leg: 'thorchain',
        provider: order.provider,
        status: 'falhou',
        txid: order.txids[0] ?? null,
        providerRef: status.outboundTxid,
      });
      await this.recordProviderEvent(order, 'failed', status);
      await enqueueSettlementEvent(
        { repos: this.deps.repos, now: () => this.now() },
        {
          intentId: order.intentId,
          eventType: 'payment_intent.conversion_failed',
          dedupeSuffix: `conversion:${order.id}:failed`,
          data: { conversion_id: order.id },
        },
      );
      result.failed++;
      return;
    }

    if (!status.done) {
      if (order.status !== 'recebendo_usdc') {
        await this.deps.repos.updateConversionOrder({
          id: order.id,
          status: 'recebendo_usdc',
        });
      }
      return;
    }

    const target = status.outboundAmountMinor ?? order.targetAmountMinor;
    if (!target || target <= 0n) {
      await this.markManual(order, 'swap concluido sem valor USDC identificado');
      result.manual++;
      return;
    }

    await this.deps.repos.updateConversionOrder({
      id: order.id,
      status: 'convertida',
      targetAmountMinor: target,
      error: null,
    });
    await this.deps.repos.upsertConversionLeg({
      conversionId: order.id,
      leg: 'thorchain',
      provider: order.provider,
      status: 'confirmado',
      txid: order.txids[0] ?? null,
      providerRef: status.outboundTxid,
      amountIn: order.sourceAmountSats,
      amountOut: target,
    });
    await this.deps.repos.updateIntentSettlement({
      intentId: order.intentId,
      from: ['convertendo'],
      to: 'convertido',
      conversionOrderId: order.id,
    });
    await this.postConversionCompleted(order, target);
    await this.recordProviderEvent(order, 'completed', status);
    await enqueueSettlementEvent(
      { repos: this.deps.repos, now: () => this.now() },
      {
        intentId: order.intentId,
        eventType: 'payment_intent.converted',
        dedupeSuffix: `conversion:${order.id}:converted`,
        data: {
          conversion_id: order.id,
          target_asset: 'USDC',
          target_chain: order.targetChain,
          target_amount_minor: target.toString(),
          outbound_txid: status.outboundTxid,
        },
      },
    );
    result.converted++;
    this.deps.logger.info(
      {
        conversionId: order.id,
        outboundTxid: status.outboundTxid,
        targetAmountMinor: target.toString(),
      },
      'conversao THORChain concluida',
    );
  }

  private async handleQuoteFailure(
    order: ConversionOrder,
    err: unknown,
  ): Promise<void> {
    const attempts = order.attempts + 1;
    const final = attempts >= this.deps.config.conversion.maxAttempts;
    await this.deps.repos.updateConversionOrder({
      id: order.id,
      status: final ? 'falhou' : 'criada',
      attempts,
      error: errorMessage(err),
    });
    if (final) {
      await this.deps.repos.updateIntentSettlement({
        intentId: order.intentId,
        from: ['convertendo'],
        to: 'manual',
        conversionOrderId: order.id,
      });
      await this.deps.alerts?.send({
        level: 'error',
        title: 'conversao falhou na quote',
        message: errorMessage(err),
        metadata: { conversionId: order.id, intentId: order.intentId },
      });
    }
    this.deps.logger.warn(
      { err, conversionId: order.id, attempts, final },
      'falha ao cotar conversao',
    );
  }

  private async handleSendFailure(
    order: ConversionOrder,
    err: unknown,
  ): Promise<void> {
    const attempts = order.attempts + 1;
    const final = attempts >= this.deps.config.conversion.maxAttempts;
    await this.deps.repos.updateConversionOrder({
      id: order.id,
      status: final ? 'manual' : 'enviando_btc',
      attempts,
      error: errorMessage(err),
    });
    if (final) {
      await this.deps.repos.updateIntentSettlement({
        intentId: order.intentId,
        from: ['convertendo'],
        to: 'manual',
        conversionOrderId: order.id,
      });
    }
    this.deps.logger.error(
      { err, conversionId: order.id, attempts, final },
      'falha ao enviar BTC para conversao',
    );
    await this.deps.alerts?.send({
      level: 'error',
      title: 'falha ao enviar BTC para conversao',
      message: errorMessage(err),
      metadata: {
        conversionId: order.id,
        intentId: order.intentId,
        final,
      },
    });
  }

  private async markManual(
    order: ConversionOrder,
    reason: string,
  ): Promise<void> {
    await this.deps.repos.updateConversionOrder({
      id: order.id,
      status: 'manual',
      error: reason,
    });
    await this.deps.repos.updateIntentSettlement({
      intentId: order.intentId,
      from: [
        'nao_iniciado',
        'aguardando_confirmacao',
        'pronto_para_conversao',
        'convertendo',
      ],
      to: 'manual',
      conversionOrderId: order.id,
    });
    await this.deps.repos.insertAuditEvent({
      actor: 'worker',
      action: 'conversion.manual',
      entity: 'conversion_order',
      entityId: order.id,
      metadata: { reason, intentId: order.intentId },
    });
    await this.deps.alerts?.send({
      level: 'warn',
      title: 'conversao requer intervencao manual',
      message: reason,
      metadata: { conversionId: order.id, intentId: order.intentId },
    });
  }

  private async postPaymentReceived(
    intent: PaymentIntent,
    amountSats: bigint,
  ): Promise<void> {
    await this.deps.ledger.postTransaction({
      kind: 'payment_received',
      referenceType: 'payment_intent',
      referenceId: intent.id,
      entries: [
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryBtc,
          asset: 'BTC',
          debitMinor: amountSats,
        },
        {
          accountCode: merchantAccountCode(intent.clientId, 'btc_receivable'),
          merchantId: intent.clientId,
          asset: 'BTC',
          creditMinor: amountSats,
        },
      ],
    });
  }

  private async postConversionCompleted(
    order: ConversionOrder,
    targetMinor: bigint,
  ): Promise<void> {
    await this.deps.ledger.postTransaction({
      kind: 'conversion_completed',
      referenceType: 'conversion_order',
      referenceId: order.id,
      entries: [
        {
          accountCode: merchantAccountCode(order.merchantId, 'btc_receivable'),
          merchantId: order.merchantId,
          asset: 'BTC',
          debitMinor: order.sourceAmountSats,
        },
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryBtc,
          asset: 'BTC',
          creditMinor: order.sourceAmountSats,
        },
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryUsdc,
          asset: 'USDC',
          debitMinor: targetMinor,
        },
        {
          accountCode: merchantAccountCode(order.merchantId, 'usdc_available'),
          merchantId: order.merchantId,
          asset: 'USDC',
          creditMinor: targetMinor,
        },
      ],
    });
  }

  private async recordProviderEvent(
    order: ConversionOrder,
    eventType: string,
    status: SwapStatus,
  ): Promise<void> {
    await this.deps.repos.insertProviderEvent({
      provider: 'thorchain',
      eventType,
      externalId: `${order.id}:${eventType}`,
      conversionId: order.id,
      payload: status.raw,
    });
  }
}
