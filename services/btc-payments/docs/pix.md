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
