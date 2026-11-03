import type { Repositories } from '../db/repositories.js';
import type { LedgerService } from '../ledger/ledger-service.js';
import type { LuniumRateLimiter } from '../adapters/lunium/rate-limiter.js';

export type MetricsServiceDeps = {
  repos: Repositories;
  ledger?: LedgerService;
  /** Limitador de chamadas a Lunium (estado do processo da API). */
  luniumLimiter?: LuniumRateLimiter;
  now?: () => Date;
};

function metric(
  name: string,
  help: string,
  type: 'counter' | 'gauge',
  samples: Array<{ labels?: Record<string, string>; value: number | bigint | string }>,
): string[] {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const sample of samples) {
    const labels = sample.labels
      ? `{${Object.entries(sample.labels)
          .map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
          .join(',')}}`
      : '';
    lines.push(`${name}${labels} ${String(sample.value)}`);
  }
  return lines;
}

/**
 * Exposition no formato Prometheus. Nao depende de lib externa e deriva os
 * valores do banco, entao API e worker enxergam o mesmo estado.
 */
export class MetricsService {
  constructor(private readonly deps: MetricsServiceDeps) {}

  async render(): Promise<string> {
    const now = this.deps.now?.() ?? new Date();
    const [counts, settlement, assetTotals] = await Promise.all([
      this.deps.repos.getStatusCounts(),
      this.deps.repos.getSettlementCounts(),
      this.deps.ledger
        ? this.deps.ledger.getAssetTotals()
        : Promise.resolve([]),
    ]);

    const lines: string[] = [];
    lines.push(
      ...metric(
        'btc_payments_intents',
        'Cobrancas por status',
        'gauge',
        Object.entries(counts.intents).map(([status, value]) => ({
          labels: { status },
          value,
        })),
      ),
      ...metric(
        'btc_payments_pix_charges',
        'Cobrancas PIX por status',
        'gauge',
        Object.entries(counts.pixCharges ?? {}).map(([status, value]) => ({
          labels: { status },
          value,
        })),
      ),
      ...metric(
        'btc_payments_pix_provider_events',
        'Eventos do provider PIX por status de processamento',
        'gauge',
        Object.entries(counts.pixProviderEvents ?? {}).map(([status, value]) => ({
          labels: { status },
          value,
        })),
      ),
      ...metric(
        'btc_payments_pix_settlement_latency_seconds',
        'Latencia media entre pagamento e liquidacao PIX',
        'gauge',
        [{ value: counts.pixSettlementLatencySeconds ?? 0 }],
      ),
      ...metric(
        'btc_payments_webhooks',
        'Eventos de webhook por status',
        'gauge',
        Object.entries(counts.webhooks).map(([status, value]) => ({
          labels: { status },
          value,
        })),
      ),
      ...metric(
        'btc_payments_sweeps',
        'Sweeps on-chain por status',
        'gauge',
        Object.entries(counts.sweeps).map(([status, value]) => ({
          labels: { status },
          value,
        })),
      ),
      ...metric(
        'btc_payments_conversions',
        'Ordens de conversao por status',
        'gauge',
        Object.entries(settlement.conversions).map(([status, value]) => ({
          labels: { status },
          value,
        })),
      ),
      ...metric(
        'btc_payments_payouts',
        'Payouts por status',
        'gauge',
        Object.entries(settlement.payouts).map(([status, value]) => ({
          labels: { status },
          value,
        })),
      ),
      ...metric('btc_payments_pending_intents', 'Cobrancas pendentes', 'gauge', [
        { value: counts.pendingIntents },
      ]),
      ...metric('btc_payments_due_webhooks', 'Webhooks vencidos', 'gauge', [
        { value: counts.dueWebhooks },
      ]),
      ...metric('btc_payments_active_sweeps', 'Sweeps ativos', 'gauge', [
        { value: counts.activeSweeps },
      ]),
      ...metric(
        'btc_payments_ledger_balanced',
        '1 se debitos e creditos batem por ativo',
        'gauge',
        [
          {
            value: assetTotals.every((item) => item.balanced) ? 1 : 0,
          },
        ],
      ),
      ...metric(
        'btc_payments_ledger_debit_minor',
        'Total de debitos por ativo',
        'gauge',
        assetTotals.map((item) => ({
          labels: { asset: item.asset },
          value: item.debit,
        })),
      ),
      ...metric(
        'btc_payments_ledger_credit_minor',
        'Total de creditos por ativo',
        'gauge',
        assetTotals.map((item) => ({
          labels: { asset: item.asset },
          value: item.credit,
        })),
      ),
      ...metric('btc_payments_uptime_seconds', 'Uptime do processo', 'gauge', [
        { value: Math.round(process.uptime()) },
      ]),
      ...(this.deps.luniumLimiter
        ? [
            ...metric(
              'btc_payments_lunium_rate_limit_max',
              'Teto efetivo de chamadas a Lunium por janela',
              'gauge',
              [{ value: this.deps.luniumLimiter.currentLimit }],
            ),
            ...metric(
              'btc_payments_lunium_rate_limit_queue',
              'Chamadas a Lunium aguardando vez',
              'gauge',
              [{ value: this.deps.luniumLimiter.queueLength }],
            ),
            ...metric(
              'btc_payments_lunium_rate_limit_cooldown_seconds',
              'Pausa restante por recusa de limite da Lunium',
              'gauge',
              [
                {
                  value:
                    Math.round(this.deps.luniumLimiter.cooldownRemaining() / 100) /
                    10,
                },
              ],
            ),
          ]
        : []),
      ...metric('btc_payments_scrape_timestamp_seconds', 'Timestamp do scrape', 'gauge', [
        { value: Math.floor(now.getTime() / 1000) },
      ]),
    );
    return `${lines.join('\n')}\n`;
  }
}
