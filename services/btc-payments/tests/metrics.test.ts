import { describe, expect, it } from 'vitest';
import type { Repositories } from '../src/db/repositories.js';
import type { LedgerService } from '../src/ledger/ledger-service.js';
import { MetricsService } from '../src/services/metrics-service.js';

describe('metrics', () => {
  it('renderiza contadores e ledger em formato Prometheus', async () => {
    const repos = {
      async getStatusCounts() {
        return {
          intents: { pago: 2, pendente: 1 },
          webhooks: { entregue: 1 },
          sweeps: { sweepado: 1 },
          pendingIntents: 1,
          dueWebhooks: 0,
          activeSweeps: 0,
          clientBalances: [],
        };
      },
      async getSettlementCounts() {
        return {
          conversions: { convertida: 2 },
          payouts: { confirmado: 2 },
        };
      },
    } as unknown as Repositories;
    const ledger = {
      async getAssetTotals() {
        return [{ asset: 'USDC', debit: 10n, credit: 10n, balanced: true }];
      },
    } as unknown as LedgerService;

    const output = await new MetricsService({
      repos,
      ledger,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    }).render();

    expect(output).toContain('btc_payments_intents{status="pago"} 2');
    expect(output).toContain('btc_payments_conversions{status="convertida"} 2');
    expect(output).toContain('btc_payments_ledger_balanced 1');
    expect(output).toContain('btc_payments_ledger_debit_minor{asset="USDC"} 10');
    expect(output).toContain('btc_payments_scrape_timestamp_seconds 1767225600');
  });
});
