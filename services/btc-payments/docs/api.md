# API de cobrancas

Base: `PUBLIC_BASE_URL` (ex.: `https://payments.example.com`).

## Autenticacao

Rotas `/v1/*` exigem HMAC:

```http
Authorization: Bearer mk_btc_live_...
X-Timestamp: 1792700000
X-Nonce: valor-unico-8-a-128-chars
X-Signature: v1=<hex>
Content-Type: application/json
```

String canonica:

```text
METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody)
```

- `PATH` sem query string.
- Timestamp com janela de 300s.
- Nonce unico por cliente; reuso retorna 401.
- O corpo assinado e o JSON exato enviado.

## Criar cobranca

`POST /v1/payment-intents`

```json
{
  "external_id": "pedido-123",
  "amount_sats": "10000",
  "description": "Pedido 123",
  "expires_in_seconds": 600,
  "metadata": { "order_id": "123" }
}
```

Resposta `201`:

```json
{
  "id": "uuid",
  "external_id": "pedido-123",
  "status": "pendente",
  "amount_sats": "10000",
  "expires_at": "2026-10-29T10:10:00.000Z",
  "grace_until": "2026-10-30T10:10:00.000Z",
  "lightning": {
    "invoice": "lnbc...",
    "payment_hash": "...",
    "expires_at": "2026-10-29T10:10:00.000Z"
  },
  "onchain": {
    "address": "bc1q...",
    "amount_btc": "0.00010000",
    "bip21": "bitcoin:bc1q...?amount=0.00010000&label=Pedido%20123&lightning=lnbc..."
  },
  "payment_uri": "bitcoin:bc1q...?amount=...&lightning=...",
  "qr_svg": "<svg ...>"
}
```

- `external_id` e a chave de idempotencia por cliente.
- Repetir com o mesmo valor retorna a mesma cobranca.
- Repetir com valor diferente retorna `409`.
- Se a criacao da invoice falhar, a intent fica `falha_criacao` e um novo
  `external_id` deve ser usado.

## Consultar

- `GET /v1/payment-intents/:id`
- `GET /v1/payment-intents?external_id=pedido-123`

Status: `criando`, `pendente`, `pago`, `parcial`, `expirado`, `pago_tardio`,
`cancelado`, `reorg`, `falha_criacao`.

## Cancelar

`POST /v1/payment-intents/:id/cancel`

Somente `pendente`. Pagamento Lightning tardio de uma cobranca cancelada nao
altera o status; fica registrado para revisao.

## Erros

```json
{
  "error": {
    "code": "validation_error",
    "message": "corpo invalido",
    "details": []
  }
}
```

Codigos comuns: `validation_error` (400), `unauthorized` (401),
`not_found` (404), `conflict` (409), `upstream_error` (502),
`service_unavailable` (503).
