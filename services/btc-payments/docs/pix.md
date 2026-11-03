# PIX -> USDC na Base (Lunium)

Fluxo paralelo ao Bitcoin: quem paga faz um PIX e a Lunium entrega USDC
nativo na Base **direto na carteira `usdc_settlement` do lojista**. A
plataforma nao custodia o USDC, nao usa carteira quente e nao paga gas.

## Fluxo

```text
Checkout
  -> POST /v1/pix-charges (exige carteira usdc_settlement ativa na loja)
  -> Lunium POST /cashin/charge
       destino=cripto, asset=usdc, chain=base,
       payout_address=<carteira usdc_settlement do lojista>
  <- qr_copypaste + qr_image_url + expires_at

Lunium
  -> POST /webhooks/lunium
  -> inbox durável (provider_events)
  -> worker consulta GET /cashin/{cashin_id}/status
  -> paid           -> pix_charge.paid (a loja pode liberar o pedido)
  -> paid + sent    -> confere na Base que o USDC chegou ao lojista
                    -> status liquidado, settlement_status pago
                    -> pix_charge.settled
```

- O CPF/CNPJ informado tem de ser o de quem paga; divergencia faz a Lunium
  devolver o PIX (`PAYER_MISMATCH`).
- Taxa Lunium: 3,3% + R$ 1,00 por cobranca (mais a comissao de parceiro, se
  houver). O valor em USDC que chega e o `asset_amount` da Lunium.

## Carteira Base de teste

```bash
cd services/btc-payments
npm run wallet:base:init          # ou: -- --json
```

O script imprime `MERCHANT_USDC_ADDRESS` e `MERCHANT_PRIVATE_KEY`. Cadastre o
endereco como `usdc_settlement` da loja de teste. Nao precisa de ETH para
receber USDC. Nunca commite a chave.

## Configuração

```env
PIX_ENABLED=false
LUNIUM_API_URL=https://api.luniumpay.com
LUNIUM_API_KEY=
LUNIUM_WEBHOOK_SECRET=
LUNIUM_TIMEOUT_MS=15000
PIX_ASSET=usdc
PIX_CHAIN=base
PIX_MIN_BRL_CENTS=2500
PIX_MAX_BRL_CENTS=25000000
PIX_VERIFY_SETTLEMENT_TX=false
JOBS_PIX_POLL_MS=30000
```

- `LUNIUM_API_KEY`: use `lun_test_` no sandbox e `lun_live_` em producao.
- `LUNIUM_WEBHOOK_SECRET`: segredo devolvido ao configurar `PATCH /keys/me`.
- A chave e o segredo ficam somente no backend/secret manager.
- O CPF/CNPJ do pagador e obrigatorio pela Lunium e nao e persistido em texto
  claro; guardamos apenas hash e ultimos 4 digitos.

### Limite de requisicoes

A Lunium aceita 60 req/min por chave. O motor segura isso em `LUNIUM_RATE_LIMIT_*`:
a API e o worker sao processos separados, cada um com a sua fatia
(`LUNIUM_RATE_LIMIT_API_MAX` + `LUNIUM_RATE_LIMIT_WORKER_MAX`, soma abaixo de
`LUNIUM_RATE_LIMIT_MAX`). Em 429 o limitador pausa pelo `retry-after`, reduz a
taxa efetiva e a reconciliacao adia o ciclo.

O catalogo (`GET /catalog`) e os limites do pagador (`GET /cashin/limits`) ficam
em cache (`LUNIUM_CATALOG_CACHE_MS`, `LUNIUM_LIMITS_CACHE_MS`): sem isso, um
pico de cobrancas gasta o limite da Lunium so com consultas de limite.

## Teste ponta a ponta no sandbox

```bash
cd services/btc-payments
npm run migrate
npm run merchant:pix:seed -- --address 0x2222222222222222222222222222222222222222
# guarda o JSON com api_key e request_secret
npm run dev
npm run worker
npm run pix:e2e -- --api-key mk_... --request-secret ... \
  --admin-token "$ADMIN_TOKEN" --lunium-api-key lun_test_...
```

O script cria a cobranca pelo motor, paga no simulador da Lunium
(`POST /sandbox/cashin/{id}/pay`) e sincroniza ate a liquidacao.

O que o sandbox ensina (medido em 2026-11-03):

| Achado | Consequencia no motor |
|---|---|
| `qr_copypaste` vem como `SANDBOX:NAO_PAGAVEL:<cashin_id>`, nao e BR Code | o QR local nao substitui o `qr_image_url` da Lunium |
| `asset_amount` nao vem; so o legado `usdt_amount` | o motor usa `usdt_amount` quando `sandbox=true` |
| `settlement_tx_hash` e `sandbox:<hash>` (nao existe on-chain) | no sandbox, `PIX_VERIFY_SETTLEMENT_TX=false` |
| `settlement_status` vira `sent` alguns segundos depois do pagamento | o `pix-reconcile` (30 s) pega sozinho; nao sincronizar na mao |
| `settlement_status: pending` e `status: paid` no mesmo instante | `pago` vem antes de `liquidado`: sao dois estados, nao um |

O E2E fecha no caminho normal: com o worker no ar, a cobranca chega em
`liquidado` sem nenhuma chamada de sincronizacao.

## API

### Criar cobrança

`POST /v1/pix-charges`

```json
{
  "external_id": "pedido-123",
  "amount": "50.00",
  "currency": "BRL",
  "payer_tax_number": "00000000191",
  "payer_name": "Cliente",
  "description": "Pedido 123",
  "metadata": { "order_id": "123" }
}
```

Resposta `201` (ou `200` em retry idempotente):

```json
{
  "id": "uuid",
  "external_id": "pedido-123",
  "provider": "lunium",
  "provider_charge_id": "ci_...",
  "status": "pendente",
  "settlement_status": "nao_iniciado",
  "amount_brl_cents": "5000",
  "asset": "USDC",
  "chain": "base",
  "pix": {
    "qr_copypaste": "000201...",
    "qr_image_url": "https://...",
    "qr_svg": "<svg ...>",
    "expires_at": "2026-10-30T20:10:00.000Z"
  },
  "payout_id": null,
  "error": null,
  "created_at": "...",
  "updated_at": "..."
}
```

### Consultar

```text
GET /v1/pix-charges/:id
GET /v1/pix-charges?external_id=pedido-123
GET /admin/api/pix-charges?limit=50
POST /admin/api/pix-charges/:id/sync
```

## Status

Local:

```text
criando | pendente | pago | liquidado | expirado | reembolsado | falhou | incerto | manual
```

Lunium:

```text
status: pending | delayed | under_review | paid | expired | refunded | failed
settlement_status: pending | sending | entregando | sent | incerto | failed
```

## Webhooks de saída

```text
pix_charge.created
pix_charge.paid
pix_charge.settled
pix_charge.expired
pix_charge.refunded
pix_charge.failed
```

A assinatura e a mesma do webhook BTC:

```text
HMAC-SHA256(webhook_secret, "${timestamp}.${rawBody}")
```

## Webhook de entrada da Lunium

`POST /webhooks/lunium`

- Verifica `X-Lunium-Signature` sobre o corpo bruto.
- Confere `X-Lunium-Event-Id` com o `event_id` do payload.
- Persiste em `provider_events` antes de responder 2xx.
- O worker consulta o estado canonico antes de creditar.
- Eventos duplicados sao idempotentes por `(provider, event_id)`.

## Regras

- Sem cancelamento na Lunium: cancelamento local so antes de `paid`.
- Timeout/5xx na criacao vira `incerto`; reconciliar por `external_id`.
- Nao criar segunda cobranca apos timeout.
- Sem carteira USDC da loja, a cobranca nem e criada: `409
  settlement_wallet_required`.
- `liquidado` ja significa USDC entregue ao lojista; nao ha payout depois.
- Status posterior a `liquidado` (ex.: refund) vira `manual` com alerta.
