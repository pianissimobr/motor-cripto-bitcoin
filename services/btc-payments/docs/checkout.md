# Checkout one-time (integração)

Pagamento único hospedado. O motor gera o "caminho" (QR/invoice), não custodia
fundos.

## Página hospedada

- `GET /pay/:id` — página pública do pagamento. O `id` é o da
  `payment_intent` (checkout em BTC) **ou** da `pix_charge` (checkout Pix):
  a página mostra o QR do trilho correspondente.
- `GET /pay/:id/status` — status em JSON:

```json
{
  "status": "Aguardando pagamento",
  "amount_sats": "1000",
  "paid": false,
  "paid_amount_sats": null,
  "paid_at": null,
  "expires_at": "2026-10-31T..."
}
```

## Criando uma cobrança

(O portal do lojista foi aposentado em 2026-11-07: `POST /v1/portal/merchants/:id/checkout` esta em `legacy/portal/`.)
Pela API direta (HMAC): `POST /v1/payment-intents`.

Exemplo (API direta):

```http
POST /v1/payment-intents
Authorization: Bearer <api_key>
X-Timestamp: 1730000000
X-Nonce: abcdefghij
X-Signature: v1=...
Content-Type: application/json

{ "external_id": "pedido-123", "amount_sats": "1000" }
```

## Checkout Pix

- (O portal do lojista foi aposentado: `POST /v1/portal/merchants/:id/pix-checkout` esta em `legacy/portal/`.)
- Pela API direta (HMAC): `POST /v1/checkout/pix` (ou `POST /v1/pix-charges`).

A resposta traz `checkout_url` (a página `/pay/{id}`) e o QR do Pix. O
pagador paga o Pix e a Lunium entrega USDC **direto** na carteira de
liquidação da loja — a plataforma não custodia.

## Snippet embutível

```html
<script src="https://SEU-DOMINIO/checkout.js" defer></script>
<button data-motor-checkout="<payment_id>">Pagar</button>
```

Ou programaticamente:

```js
MotorCheckout.open('<payment_id>');
```

O snippet abre a página `/pay/:id` em popup, no mesmo domínio.