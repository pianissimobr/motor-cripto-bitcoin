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

## 5. Divergencia no ledger

Em banco de teste, remova uma entry e confirme que
`GET /admin/api/reconciliation` retorna `ok=false` e que o worker alerta.

## 6. Lojista gasta o BTC recebido

Pague uma cobranca on-chain, espere `pago` e gaste o UTXO pela carteira do
lojista. Confirme que a cobranca continua `pago`, a saida vira `gasto` e nenhum
`payment_intent.reorged` e enviado.
