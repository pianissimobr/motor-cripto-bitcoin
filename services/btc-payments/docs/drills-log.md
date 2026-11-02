# Diario de drills

## 2026-10-30 — backup/restore em banco descartavel

- Origem: `btc_payments_test`
- Dump: `/tmp/btc-backups/btc-payments-20261030T201208Z.sql.gz`
- Destino: `btc_payments_restore`
- Resultado: gzip OK, checksum OK, 23 tabelas, 1 intent, 10 migrations.
- Comando base:

```bash
COMPOSE_FILE=docker-compose.yml POSTGRES_USER=btc POSTGRES_DB=btc_payments_test \
  DB_SERVICE=db BACKUP_DIR=/tmp/btc-backups npm run backup

printf 'verificar\n' | COMPOSE_FILE=docker-compose.yml RESTORE_DB_SERVICE=db \
  POSTGRES_USER=btc POSTGRES_DB=btc_payments_restore \
  RESTORE_DATABASE_URL=postgres://btc:btc_dev_password@localhost:5434/btc_payments_restore \
  npm run backup:verify -- /tmp/btc-backups/btc-payments-20261030T201208Z.sql.gz
```

## 2026-10-30 — dependency down (nao destrutivo)

- API local na porta 4581, banco de teste, `SWEEP_ENABLED=false`.
- `/health`: 200.
- `/ready`: 503 porque Esplora nao estava no ar.
- Com LNbits parado, `/ready` continuou 503.
- `/metrics`: 200, expondo `btc_payments_ledger_balanced` e contadores.
- Conclusao: dependencia fora derruba readiness sem derrubar health/metrics.

## Pendente

- Drill de swap THORChain pequeno e payout revertido com signer/carteira de
  teste (dependem de infraestrutura externa).
