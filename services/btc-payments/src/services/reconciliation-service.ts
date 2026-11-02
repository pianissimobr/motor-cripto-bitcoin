import type { Repositories } from '../db/repositories.js';
import type { LedgerService } from '../ledger/ledger-service.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';

export type ReconciliationServiceDeps = {
  repos: Repositories;
  ledger: LedgerService;
  logger: Logger;
  alerts?: AlertService;
  now?: () => Date;
};

export type ReconciliationResult = {
  ok: boolean;
  runId: string;
  conversions: Record<string, number>;
  pixCharges: Record<string, number>;
  payouts: Record<string, number>;
  ledger: Array<{
    asset: string;
    debit: string;
    credit: string;
    balanced: boolean;
  }>;
  pendingIntents: number;
  dueWebhooks: number;
  activeSweeps: number;
};

/**
 * Reconcilia diariamente os saldos do ledger e os estados de liquidacao.
 * Grava cada execucao em reconciliation_runs e alerta quando ha divergencia
 * ou itens presos que exigem operacao manual.
 */
export class ReconciliationService {
  constructor(private readonly deps: ReconciliationServiceDeps) {}

  async runCycle(): Promise<ReconciliationResult> {
    const run = await this.deps.repos.insertReconciliationRun('daily');
    const [counts, settlement, assetTotals] = await Promise.all([
      this.deps.repos.getStatusCounts(),
      this.deps.repos.getSettlementCounts(),
      this.deps.ledger.getAssetTotals(),
    ]);

    const balanced = assetTotals.every((item) => item.balanced);
    const failedConversions =
      (settlement.conversions.falhou ?? 0) +
      (settlement.conversions.manual ?? 0);
    const ok = balanced && manualWork(settlement) === 0;

    const details = {
      intents: counts.intents,
      pixCharges: counts.pixCharges,
      webhooks: counts.webhooks,
      sweeps: counts.sweeps,
      conversions: settlement.conversions,
      payouts: settlement.payouts,
      pendingIntents: counts.pendingIntents,
      dueWebhooks: counts.dueWebhooks,
      activeSweeps: counts.activeSweeps,
      ledger: assetTotals.map((item) => ({
        asset: item.asset,
        debit: item.debit.toString(),
        credit: item.credit.toString(),
        balanced: item.balanced,
      })),
    };

    if (!balanced) {
      await this.deps.alerts?.send({
        level: 'critical',
        title: 'ledger desbalanceado',
        message: 'debitos e creditos nao batem em pelo menos um ativo',
        metadata: {
          ledger: assetTotals.map((item) => ({
            asset: item.asset,
            debit: item.debit.toString(),
            credit: item.credit.toString(),
            balanced: item.balanced,
          })),
        },
      });
    }
    if (failedConversions > 0) {
      await this.deps.alerts?.send({
        level: 'warn',
        title: 'conversoes pendentes de revisao',
        message: `${failedConversions} conversao(oes) em falha/manual`,
        metadata: { conversions: settlement.conversions },
      });
    }
    const stuckPix =
      (counts.pixCharges.incerto ?? 0) + (counts.pixCharges.manual ?? 0);
    if (stuckPix > 0) {
      await this.deps.alerts?.send({
        level: 'warn',
        title: 'cobrancas PIX pendentes de revisao',
        message: `${stuckPix} cobranca(s) PIX incerta(s)/manual(is)`,
        metadata: { pixCharges: counts.pixCharges },
      });
    }
    const stuckPayouts =
      (settlement.payouts.falhou ?? 0) + (settlement.payouts.retido ?? 0);
    if (stuckPayouts > 0) {
      await this.deps.alerts?.send({
        level: 'warn',
        title: 'payouts pendentes de revisao',
        message: `${stuckPayouts} payout(s) falhou/retido`,
        metadata: { payouts: settlement.payouts },
      });
    }
    if (counts.dueWebhooks > 0) {
      await this.deps.alerts?.send({
        level: 'warn',
        title: 'webhooks vencidos',
        message: `${counts.dueWebhooks} webhook(s) aguardando entrega`,
        metadata: { dueWebhooks: counts.dueWebhooks },
      });
    }

    this.deps.logger.info({ runId: run.id, ok, details }, 'reconciliacao diaria');
    await this.deps.repos.finishReconciliationRun({
      id: run.id,
      ok,
      details,
    });
    return { ok, runId: run.id, ...details };
  }
}

function manualWork(settlement: { conversions: Record<string, number>; payouts: Record<string, number> }): number {
  return (
    (settlement.conversions.falhou ?? 0) +
    (settlement.conversions.manual ?? 0) +
    (settlement.payouts.falhou ?? 0) +
    (settlement.payouts.retido ?? 0)
  );
}
