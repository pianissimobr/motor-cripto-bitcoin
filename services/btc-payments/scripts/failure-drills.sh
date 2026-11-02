#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Drills destrutivos/controlados. Rode apenas em ambiente descartavel.
: "${DRILL_BASE_URL:=http://localhost:4580}"
: "${DRILL_ADMIN_TOKEN:=${ADMIN_TOKEN:-}}"
: "${DRILL_COMPOSE_FILE:=docker-compose.yml}"

need() { : "${DRILL_ADMIN_TOKEN:?defina DRILL_ADMIN_TOKEN ou ADMIN_TOKEN}"; }
status() { curl -fsS "$DRILL_BASE_URL/admin/api/status" -H "Authorization: Bearer $DRILL_ADMIN_TOKEN"; }

case "${1:-help}" in
  plan)
    cat <<TXT
Cenarios de falha para executar depois:
  1. lnbits-down     para o LNbits e confirma /ready 503 e intent falha_criacao.
     comando: docker compose -f "$DRILL_COMPOSE_FILE" stop lnbits
   2. esplora-down    para o Esplora e confirma job onchain falhando + alerta.
     comando: docker compose -f "$DRILL_COMPOSE_FILE" stop esplora
   3. webhook-fail    aponta webhook de teste para URL invalida e confere retries.
     crie cliente com webhook_url http://127.0.0.1:9/nope
     pague uma intent e veja webhook_events.attempts/last_error
   4. payout-revert   use uma carteira/signer descartavel e force revert on-chain.
     confirme payout.status=falhou e evento payment_intent.payout_failed
   5. ledger-drift    em banco de teste, remova uma entry e confirme /admin/api/reconciliation ok=false
   6. restart         reinicie API/worker no meio de um sweep e confirme idempotencia.
TXT
  ;;
  status)
    need
    status
    ;;
  health)
    curl -fsS "$DRILL_BASE_URL/health"; echo
    curl -fsS "$DRILL_BASE_URL/ready"; echo
    ;;
  webhooks)
    need
    curl -fsS "$DRILL_BASE_URL/admin/api/webhooks?limit=50" -H "Authorization: Bearer $DRILL_ADMIN_TOKEN"
    ;;
  reconciliation)
    need
    curl -fsS "$DRILL_BASE_URL/admin/api/reconciliation" -H "Authorization: Bearer $DRILL_ADMIN_TOKEN"
    ;;
  stop-lnbits)
    docker compose -f "$DRILL_COMPOSE_FILE" stop lnbits
    ;;
  start-lnbits)
    docker compose -f "$DRILL_COMPOSE_FILE" start lnbits
    ;;
  *)
    echo "uso: $0 {plan|status|health|webhooks|reconciliation|stop-lnbits|start-lnbits}" >&2
    exit 1
    ;;
esac
