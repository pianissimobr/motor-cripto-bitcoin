# Drills de falha

Execute somente em ambiente descartavel (regtest/homologacao). O script
`npm run drills plan` lista os cenarios abaixo.

## 1. LNbits indisponivel

```bash
npm run drills -- stop-lnbits
curl -i http://localhost:4580/ready        # esperado: 503
# criar intent e confirmar falha_criacao/502
npm run drills -- start-lnbits
```

## 2. Esplora indisponivel

Pare o Esplora/electrs e confirme que o job `onchain-watch` falha, que um alerta
e enviado e que pagamentos Lightning continuam.

## 3. Webhook falhando

Crie um cliente com `webhook_url` invalida, pague uma intent e confira
`webhook_events.attempts`, `next_attempt_at` e `last_error`. Reprocesse com
`POST /admin/api/webhooks/:id/replay`.

## 4. Payout revertido

Use uma carteira/signer descartavel e force um revert on-chain. Confirme
`payout.status=falhou`, o evento `payment_intent.payout_failed` e o estorno no
ledger.

## 5. Divergencia no ledger

Em banco de teste, remova uma entry e confirme que
`GET /admin/api/reconciliation` retorna `ok=false` e que o worker alerta.

## 6. Restart no meio do sweep

Reinicie API/worker durante um sweep e confirme idempotencia: sem sweep
duplicado, sem ledger duplicado e status consistente.
