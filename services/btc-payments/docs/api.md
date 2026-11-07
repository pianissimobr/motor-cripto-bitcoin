# API de cobrancas

O contrato completo, com todos os corpos, está em
[`docs/API.md`](../../../docs/API.md) na raiz do repositório. Esta página é o
resumo ao lado do código.

Base: `PUBLIC_BASE_URL` (ex.: `https://payments.example.com`).

> Além da API HMAC, há também o **portal do lojista** (`/auth/*`,
> `/v1/portal/*`), a **página pública de checkout** (`/pay/:id`) e o **snippet**
> (`/checkout.js`). Guia passo a passo em [manual.md](manual.md).

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

Escopos por cliente:

```text
payments:write  payments:read
wallets:read    wallets:write
balances:read   conversions:read  payouts:read   (os tres ultimos: so historico)
gas:write       (so a gas station: emprestar nativo ao cliente)
```

Escopo ausente retorna `403`.

O `gas:write` fica fora do padrao dos clientes novos de proposito: uma chave
vazada nao empresta POL para ninguem. Quem precisa dele (o app BlueWallet) tem
o escopo concedido no proprio cliente; trocar a credencial do app exige
desativar a antiga no banco.

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

## Historico

`GET /v1/balances`, `GET /v1/conversions` e `GET /v1/payouts` ficam so como
historico de versoes anteriores. O motor nao converte nem paga: o dinheiro vai
direto para as carteiras do lojista.

## Carteiras

`GET /v1/wallets`

`POST /v1/wallets` aceita:

```json
{ "kind": "lightning_lnbits", "lnbits_url": "https://seu-lnbits.com", "invoice_key": "..." }
```

```json
{ "kind": "btc_deposit", "xpub": "tpub...", "derivation_prefix": "0" }
```

```json
{ "kind": "usdc_settlement", "address": "0x...", "purpose": "loja" }
```

`purpose` diz de quem e o endereco:

- `loja` (padrao): a carteira de liquidacao da **propria loja** — e onde o PIX
  que a loja cobra cai. Nao precisa de prova.
- `cliente`: o endereco de um **cliente** que a loja cadastrou para liquidar
  a compra dele na carteira que o app gerou (F4). Aqui a prova de posse e
  obrigatoria:

```json
{
  "kind": "usdc_settlement",
  "address": "0x...",
  "purpose": "cliente",
  "proof": { "nonce": "...", "signature": "0x..." }
}
```

Sem a prova, o cadastro e recusado (`400`): e o que impede cadastrar o
endereco de outra pessoa e ficar com o dinheiro. O app mostra a prova (QR)
na tela "Provar posse".

O endereco USDC e unico por loja. Repetir o mesmo endereco na mesma loja e
idempotente; em outra loja retorna `409`.

## Taxas

`GET /v1/fx/rates` retorna `BTC/BRL` e `BTC/USD` atuais com `source` e
`observed_at`.

## Admin

Exigem `Authorization: Bearer <ADMIN_TOKEN>`:

```text
GET  /admin/api/merchants
GET  /admin/api/conversions            (historico)
GET  /admin/api/payouts            (historico)
GET  /admin/api/reconciliation
```

`GET /admin/api/reconciliation` retorna `ok` e confere se debitos e creditos
do ledger batem por ativo.


## PIX -> USDC

`POST /v1/pix-charges` cria uma cobrança PIX na Lunium que entrega USDC na
**Polygon** (a rede da chave de producao) direto na carteira
`usdc_settlement` da loja. Sem essa carteira a resposta e
`409 settlement_wallet_required`.

```json
{
  "external_id": "pedido-123",
  "amount": "50.00",
  "currency": "BRL",
  "payer_tax_number": "00000000191",
  "payer_name": "Cliente"
}
```

Resposta:

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
  "chain": "polygon",
  "pix": {
    "qr_copypaste": "000201...",
    "qr_image_url": "https://...",
    "qr_svg": "<svg ...>",
    "expires_at": "..."
  },
  "payout_id": null
}
```

Consultas:

```text
GET /v1/pix-charges/:id
GET /v1/pix-charges?external_id=pedido-123
```

### Checkout PIX (pagina hospedada)

`POST /v1/checkout/pix` cria a mesma cobrança e devolve tambem o
`checkout_url` (a pagina publica `/pay/{id}`, com o QR do Pix). Aceita
`destination_address` (o endereco de um cliente, cadastrado pela loja com
prova de posse) — sem ele, o USDC vai para a carteira de liquidacao da loja.

```json
{
  "external_id": "pedido-123",
  "amount_cents": "5000",
  "payer_tax_number": "00000000191",
  "payer_name": "Cliente",
  "destination_address": "0x..."
}
```

Pelo portal, a mesma coisa sem integracao: `POST /v1/portal/merchants/:id/pix-checkout`
(sessao de lojista).

Detalhes em [pix.md](pix.md).

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
