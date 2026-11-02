# PIX -> USDC na Base (Lunium)

Fluxo paralelo ao Bitcoin: o cliente paga uma cobrança PIX e a loja recebe
USDC nativo na Base, via treasury intermediaria.

## Fluxo

```text
Checkout
  -> POST /v1/pix-charges
  -> Lunium POST /cashin/charge
       destino=cripto, asset=usdc, chain=base,
       payout_address=<TREASURY_USDC_ADDRESS>
  <- qr_copypaste + qr_image_url + expires_at

Lunium
  -> POST /webhooks/lunium
  -> inbox durável (provider_events)
  -> worker consulta GET /cashin/{cashin_id}/status
  -> ledger: débito treasury:usdc / crédito merchant:<id>:usdc_available
  -> PayoutService envia USDC na Base para a carteira allowlisted da loja
```


## Carteiras Base de teste

Gere duas carteiras EVM descartaveis: uma treasury quente (recebe USDC da
Lunium e paga a loja) e uma carteira de loja (recebe o payout).

```bash
cd services/btc-payments
npm run wallet:base:init
# ou para automacao:
npm run wallet:base:init -- --json
```

O script imprime:

```env
PAYOUT_HOT_ADDRESS=0x...
TREASURY_USDC_ADDRESS=0x...
BASE_PAYOUT_PRIVATE_KEY=0x...
MERCHANT_USDC_ADDRESS=0x...
MERCHANT_PRIVATE_KEY=0x...
```

- `TREASURY_USDC_ADDRESS` e `PAYOUT_HOT_ADDRESS` devem ser o mesmo endereco.
- A treasury precisa de ETH na Base para gas.
- A carteira da loja nao precisa de ETH para receber USDC.
- Cadastre `MERCHANT_USDC_ADDRESS` como `usdc_settlement` da loja.
- Nunca commite as chaves. Use apenas em ambiente de teste.

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
pix_charge.payout_pending
pix_charge.payout_sent
pix_charge.payout_confirmed
pix_charge.payout_failed
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
- Sem carteira USDC da loja, a cobranca fica `manual` e gera alerta.
- `PAYOUT_ENABLED=false` mantem a cobranca `liquidado`; o job de payout pega
  quando habilitado.
