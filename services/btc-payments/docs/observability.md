# Observabilidade e reconciliacao

## Metricas

`GET /metrics` expoe o formato Prometheus (`text/plain; version=0.0.4`).
Se `METRICS_TOKEN` estiver definido, a rota exige
`Authorization: Bearer <METRICS_TOKEN>`. Em producao, exponha apenas em rede
privada, VPN ou atras de proxy com allowlist.

Series principais:

```text
btc_payments_intents{status="..."}
btc_payments_pix_charges{status="..."}
btc_payments_pix_provider_events{status="pendente|processado"}
btc_payments_pix_settlement_latency_seconds
btc_payments_webhooks{status="..."}
btc_payments_sweeps{status="..."}
btc_payments_conversions{status="..."}
btc_payments_payouts{status="..."}
btc_payments_pending_intents
btc_payments_due_webhooks
btc_payments_active_sweeps
btc_payments_ledger_balanced
btc_payments_ledger_debit_minor{asset="BTC|BRL|USD|USDC"}
btc_payments_ledger_credit_minor{asset="BTC|BRL|USD|USDC"}
btc_payments_uptime_seconds
btc_payments_scrape_timestamp_seconds
```

As metricas sao derivadas do Postgres, portanto API e worker enxergam o mesmo
estado. Um `btc_payments_ledger_balanced` igual a `0` e incidente critico.

## Alertas

O worker envia alertas para `ALERT_WEBHOOK_URL` quando:

- um job falha;
- um sweep fica manual ou falha;
- pagamento duplicado ou reorg e detectado;
- a reconciliacao diaria encontra ledger desbalanceado;
- existem conversoes em `falhou/manual`, payouts em `falhou/retido`, cobrancas
  PIX em `incerto/manual` ou webhooks vencidos.

## Reconciliacao diaria

O job `reconciliation` roda no boot do worker e a cada
`JOBS_RECONCILIATION_MS` (padrao 24h). Cada execucao grava uma linha em
`reconciliation_runs` com contagens e totais do ledger.

Consultas:

```sql
select job, started_at, finished_at, ok from reconciliation_runs
 order by started_at desc limit 10;

select status, count(*) from conversion_orders group by status;
select status, count(*) from pix_charges group by status;
select status, count(*) from payouts group by status;
select status, count(*) from webhook_events group by status;
```

Endpoint admin:

```text
GET /admin/api/reconciliation
GET /admin/api/reconciliation/runs?limit=50
```

## Sugestao de alertas externos

- `btc_payments_ledger_balanced == 0` por mais de 1 minuto: page.
- `btc_payments_due_webhooks > 100` por 15 minutos: warn.
- `btc_payments_payouts{status="retido"} > 0` por 1h: warn.
- `btc_payments_conversions{status="manual"} > 0` por 1h: warn.
- gas ETH da carteira quente abaixo de `PAYOUT_MIN_GAS_WEI`: warn.
