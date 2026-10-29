# Webhooks

## Saida para o cliente

Eventos:

- `payment_intent.paid`
- `payment_intent.paid_late`
- `payment_intent.partial`
- `payment_intent.expired`
- `payment_intent.canceled`
- `payment_intent.reorged`

Headers:

```http
X-Webhook-Signature: t=<unix>,v1=<hex>
X-Webhook-Event: payment_intent.paid
X-Webhook-Delivery: <event_id>
Content-Type: application/json
```

Assinatura:

```text
HMAC-SHA256(webhook_secret, "${timestamp}.${rawBody}")
```

Payload:

```json
{
  "event": "payment_intent.paid",
  "event_id": "uuid",
  "created_at": "2026-10-29T10:04:30.000Z",
  "data": {
    "id": "uuid",
    "external_id": "pedido-123",
    "status": "pago",
    "amount_sats": "10000",
    "paid_amount_sats": "10000",
    "paid_rail": "onchain",
    "paid_at": "2026-10-29T10:04:30.000Z",
    "overpaid_sats": "0"
  }
}
```

Verificacao em Node:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const expected = createHmac('sha256', secret)
  .update(`${t}.${rawBody}`)
  .digest('hex');
const ok =
  expected.length === v1.length &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

Entrega:

- outbox grava antes da primeira tentativa;
- retry com backoff `60s, 5m, 30m, 2h, 6h, 24h`;
- `X-Webhook-Delivery`/`event_id` permitem deduplicar;
- resposta 2xx = entregue; qualquer outra coisa = retry.

## Entrada do LNbits

`POST /webhooks/lnbits?token=<LNBITS_WEBHOOK_TOKEN>`

- O token e comparado em tempo constante.
- O payload nao e confiavel: o status e confirmado em
  `GET /api/v1/payments/{payment_hash}`.
- A versao 1.6 do LNbits envia `payment.json()`, que chega como string JSON;
  o endpoint aceita objeto e string.
- Erros de verificacao no LNbits retornam 5xx para o LNbits tentar de novo.
