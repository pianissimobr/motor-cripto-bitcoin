# API do serviço Bitcoin

> **Referência histórica.** Este texto descreve uma versão anterior do motor
> (com xpub e carteira fria da plataforma, sweep e conversão). Hoje o dinheiro
> cai direto nas carteiras do lojista (wallet LNbits, xpub e USDC na Base) e não
> há sweep nem conversão. O contrato atual está em
> [services/btc-payments/README.md](../services/btc-payments/README.md).

Base local: `http://localhost:4580`. Em produção, `PUBLIC_BASE_URL` do `services/btc-payments/.env`.

Este documento é o contrato. O mapa do código e o caminho de um pagamento estão em [guia.md](guia.md). O livro HTML, com a mesma matéria, está em [index.html](index.html).

Datas saem em ISO-8601 UTC. Satoshis saem como string decimal sem ponto. Nada neste contrato usa float.

Há quatro portas de entrada:

| Quem | Prefixo | Credencial |
| --- | --- | --- |
| Loja | `/v1/` | API key + HMAC |
| Operador | `/admin/api/` | `Authorization: Bearer {ADMIN_TOKEN}` |
| LNbits | `POST /webhooks/lnbits` | `?token=` igual a `LNBITS_WEBHOOK_TOKEN` |
| Probe | `GET /health`, `GET /ready` | nenhuma |

Corpo máximo: 64 KiB. Acima disso a resposta é 413, `code: bad_request`. JSON desconhecido num corpo `.strict()` é 400.

O limite é 120 pedidos por janela de 60 segundos. A chave da loja e do admin é o hash (SHA-256) do cabeçalho `Authorization`, então cada cliente tem o seu balde. O webhook do LNbits usa o IP. `/health` não conta. Estourar devolve 429.

---

## Erro

Todo erro de aplicação tem este corpo:

```json
{
  "error": {
    "code": "validation_error",
    "message": "corpo invalido",
    "details": []
  }
}
```

`details` só aparece quando o erro é exposto e o servidor tem o que detalhar (em geral os issues do Zod). Erro 500 genérico esconde a mensagem e devolve `erro interno`.

| HTTP | code | Quando |
| --- | --- | --- |
| 400 | `validation_error` | Corpo, query ou path não passou no schema. `amount_sats` com fração, sinal ou vazio. `expires_in_seconds` fora de 30–86400 |
| 401 | `unauthorized` | API key ausente ou desconhecida, cliente `inativo`, relógio fora de 300 s, nonce ausente, curto, longo ou reutilizado, assinatura errada, token admin errado, token do LNbits errado |
| 404 | `not_found` | Intent de outro cliente, id que não existe, webhook ou sweep que não existe |
| 409 | `conflict` | Mesmo `external_id` com outro valor; `external_id` em `criando` ou `falha_criacao`; cancelar fora de `pendente`; retry de sweep com tx confirmado ou ainda na mempool |
| 413 | `bad_request` | Corpo acima de 64 KiB |
| 429 | limite do Fastify | Janela de 120/min daquele cliente ou daquele IP |
| 502 | `upstream_error` | LNbits não criou a invoice. A intent ficou `falha_criacao`. Use outro `external_id` |
| 503 | `service_unavailable` | `GET /ready` com algum check falho |

---

## Autenticação da loja

Toda rota `/v1/*` exige os quatro cabeçalhos. Não há cookie e não há API key sozinha.

```http
Authorization: Bearer mk_btc_live_...
X-Timestamp: 1792700000
X-Nonce: pedido-123-tentativa-1
X-Signature: v1=0123abcd...
Content-Type: application/json
```

`X-Timestamp` é Unix em segundos. Fora de 300 segundos para mais ou para menos, a resposta é 401, antes de olhar o nonce.

`X-Nonce` tem de 8 a 128 caracteres e é único por cliente. O servidor guarda o nonce por 10 minutos. Reusar devolve 401 mesmo que o resto esteja certo. Um retry de rede precisa de nonce novo. A idempotência da cobrança é o `external_id`, não o nonce.

A assinatura é HMAC-SHA256, em hex, do texto abaixo. As quebras de linha são `\n` de verdade. `PATH` não inclui a query string. `SHA256` é o hash hex do corpo cru, exatamente os bytes enviados. GET e cancelamento assinam corpo vazio, e o hash desse vazio entra na última linha.

```text
METHOD
PATH
TIMESTAMP
NONCE
SHA256(corpo cru)
```

`X-Signature` aceita o hex puro ou o prefixo `v1=`. A comparação é em tempo constante.

A API key mostrada na criação do cliente começa com `mk_btc_live_`. O servidor só guarda o SHA-256 dela. O `request_secret`, usado como chave do HMAC, é mostrado uma vez e guardado cifrado.

Exemplo mínimo, em Node, para criar uma cobrança:

```js
import { createHash, createHmac, randomBytes } from 'node:crypto';

const body = JSON.stringify({
  external_id: 'pedido-123',
  amount_sats: '10000',
  description: 'Pedido 123',
});
const timestamp = Math.floor(Date.now() / 1000).toString();
const nonce = randomBytes(16).toString('hex');
const path = '/v1/payment-intents';
const canonical = ['POST', path, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
const signature = createHmac('sha256', requestSecret).update(canonical).digest('hex');
```

---

## Criar cobrança

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

| Campo | Regra |
| --- | --- |
| `external_id` | Obrigatório. 1 a 128 caracteres, sem espaço nas pontas. Único por cliente. É a chave de idempotência |
| `amount_sats` | Obrigatório. String de dígitos ou inteiro positivo. Até 21.000.000 BTC em sats. Zero, fração e sinal são 400 |
| `description` | Opcional. Até 200 caracteres. Vira o `label` da URI BIP21. Se faltar, o label é o `external_id` |
| `expires_in_seconds` | Opcional. Inteiro de 30 a 86400. Ausente usa `INTENT_TTL_SECONDS` (600) |
| `metadata` | Opcional. Objeto JSON. Guardado na intent. Não volta no GET nem no webhook |

Campo extra no JSON é 400, porque o corpo é estrito.

Cobrança nova responde **201**. O mesmo `external_id` com o mesmo valor, numa cobrança que já tem invoice, responde **200** com o mesmo corpo. Não cria outro endereço.

```json
{
  "id": "6f1c2c2e-3b4a-4d5e-8f70-1a2b3c4d5e6f",
  "external_id": "pedido-123",
  "status": "pendente",
  "amount_sats": "10000",
  "description": "Pedido 123",
  "expires_at": "2026-10-29T12:10:00.000Z",
  "grace_until": "2026-10-30T12:10:00.000Z",
  "paid_at": null,
  "paid_rail": null,
  "paid_amount_sats": null,
  "overpaid_sats": null,
  "lightning": {
    "invoice": "lnbc100n1...",
    "payment_hash": "abc123...",
    "expires_at": "2026-10-29T12:10:00.000Z"
  },
  "onchain": {
    "address": "bc1q...",
    "amount_btc": "0.00010000",
    "bip21": "bitcoin:bc1q...?amount=0.00010000&label=Pedido%20123&lightning=lnbc100n1..."
  },
  "payment_uri": "bitcoin:bc1q...?amount=0.00010000&label=Pedido%20123&lightning=lnbc100n1...",
  "qr_svg": "<svg ...>...</svg>",
  "created_at": "2026-10-29T12:00:00.000Z",
  "updated_at": "2026-10-29T12:00:00.000Z"
}
```

`amount_btc` tem sempre 8 casas. 10.000 sats são `0.00010000`. `payment_uri` é o mesmo texto de `onchain.bip21`. `qr_svg` é o QR dessa URI, 320 px, correção de erro M. Mostre esse QR. Não monte outro que esqueça o parâmetro `lightning`.

`expires_at` é o fim da invoice e o fim da janela em que a confirmação on-chain ainda é `pago` em vez de `pago_tardio`. `grace_until` é `expires_at` mais `INTENT_GRACE_SECONDS` (86400).

Enquanto o LNbits ainda não respondeu, um segundo POST do mesmo `external_id` recebe 409 com a mensagem de que a cobrança ainda está sendo criada. Tente de novo. Não trate esse 409 como “pedido já existe” e não entregue um QR: a resposta não traz invoice.

Se o LNbits falha, 502. Aquele `external_id` fica `falha_criacao` para sempre.

---

## Ler cobrança

`GET /v1/payment-intents/:id`

`id` é UUID. Intent de outro cliente é 404, igual a id inexistente.

`GET /v1/payment-intents?external_id=pedido-123`

`external_id` é obrigatório nessa query, 1 a 128 caracteres. Sem ele, 400.

Os dois devolvem o mesmo objeto da criação, com `status`, `paid_at`, `paid_rail`, `paid_amount_sats` e `overpaid_sats` atualizados. `metadata` continua de fora.

Status possíveis: `criando`, `pendente`, `pago`, `pago_tardio`, `parcial`, `expirado`, `cancelado`, `reorg`, `falha_criacao`.

`paid_rail` é `lightning`, `onchain`, `both` ou `null`.

`pago` significa valor coberto até `expires_at`. `pago_tardio` significa valor coberto depois disso, ainda dentro da carência, ou Lightning que o LNbits confirmou com a intent já vencida. Os dois são pagamento recebido. `parcial` é sats confirmados abaixo do pedido no vencimento. `reorg` desfaz um pago: a loja deve rever aquele `external_id`. O webhook pede isso; o GET confirma o estado atual.

---

## Cancelar

`POST /v1/payment-intents/:id/cancel`

Sem corpo. A assinatura usa corpo vazio.

Só `pendente` cancela. Qualquer outro status é 409. A resposta 200 é a cobrança com `status: "cancelado"`. Sai o webhook `payment_intent.canceled`.

Pagar a invoice ou o endereço depois do cancelamento não reabre a cobrança. Lightning pago assim fica no LNbits e gera alerta para o operador. On-chain que aparecer depois é varrido para a carteira fria e também gera alerta, sem marcar `pago`.

---

## Webhook que a loja recebe

O worker faz `POST` na `webhook_url` do cliente. Não segue redirect. Timeout padrão: 10 segundos.

```http
POST /webhooks/motor HTTP/1.1
Content-Type: application/json
User-Agent: btc-payments-webhook/1
X-Webhook-Signature: t=1792700000,v1=0123abcd...
X-Webhook-Event: payment_intent.paid
X-Webhook-Delivery: 8c1d...uuid da linha do outbox
```

O HMAC é SHA-256 de `{timestamp}.{corpo cru}`, chave `webhook_secret`. O header é `t=<unix>,v1=<hex>`.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function webhookOk(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const got = Buffer.from(parts.v1);
  const exp = Buffer.from(expected);
  return got.length === exp.length && timingSafeEqual(got, exp);
}
```

Confira o relógio de `t` no seu lado. Use o corpo cru, antes de reparsear.

```json
{
  "event": "payment_intent.paid",
  "event_id": "uuid novo a cada linha do outbox",
  "created_at": "2026-10-29T12:04:00.000Z",
  "data": {
    "id": "6f1c2c2e-3b4a-4d5e-8f70-1a2b3c4d5e6f",
    "external_id": "pedido-123",
    "status": "pago",
    "amount_sats": "10000",
    "paid_amount_sats": "10000",
    "paid_rail": "lightning",
    "paid_at": "2026-10-29T12:04:00.000Z",
    "overpaid_sats": "0"
  }
}
```

| event | status em data | Quando |
| --- | --- | --- |
| `payment_intent.paid` | `pago` | Lightning ou on-chain cobriu o pedido até `expires_at`, ou um `reorg` voltou a coberto dentro do prazo |
| `payment_intent.paid_late` | `pago_tardio` | A cobertura aconteceu depois de `expires_at` |
| `payment_intent.partial` | `parcial` | Venceu com sats confirmados abaixo do pedido |
| `payment_intent.expired` | `expirado` | Venceu sem sats confirmados. Mempool sozinha não segura |
| `payment_intent.canceled` | `cancelado` | A loja cancelou uma intent `pendente` |
| `payment_intent.reorged` | `reorg` | O depósito sumiu de verdade e o que ainda está em custódia ficou abaixo do pedido |

`paid_amount_sats` é o que o motor contabilizou. Leia esse campo. Não assuma o valor do pedido só porque o evento é `paid`. `overpaid_sats` acima de zero é excesso on-chain. Num pagamento só Lightning que bateu a invoice, o excesso é zero.

A chave que evita dois webhooks da mesma transição é `intent:{id}:{tipo}:{version}`. `pago` seguido de `reorg` seguido de `pago` produz um segundo `payment_intent.paid`, porque a version mudou. Guarde `event_id` ou `X-Webhook-Delivery`. Se a sua resposta demorar além do timeout, o motor tenta de novo e o mesmo evento pode chegar duas vezes.

Resposta 2xx marca entregue. Qualquer outra coisa, timeout ou redirect, entra de novo: 60 segundos, 5 minutos, 30 minutos, 2 horas, 6 horas e 24 horas. Na sexta falha (`WEBHOOK_MAX_ATTEMPTS`) para. O operador reenfileira com o replay do admin.

O webhook não inclui a invoice, o endereço, nem `metadata`.


---

## PIX -> USDC na Base

`POST /v1/pix-charges`

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
  "chain": "base",
  "pix": {
    "qr_copypaste": "000201...",
    "qr_image_url": "https://...",
    "qr_svg": "<svg ...>",
    "expires_at": "..."
  },
  "payout_id": null,
  "error": null
}
```

Consultas:

```text
GET /v1/pix-charges/:id
GET /v1/pix-charges?external_id=pedido-123
```

O CPF/CNPJ do pagador é obrigatório pela Lunium. Ele não é persistido em
texto claro. O fluxo completo, status e webhooks estão em
[services/btc-payments/docs/pix.md](../services/btc-payments/docs/pix.md).

---

## Webhook de entrada do LNbits

`POST /webhooks/lnbits?token={LNBITS_WEBHOOK_TOKEN}`

Sem HMAC de loja. O token da query é a credencial. Token errado é 401.

O corpo é um objeto JSON, ou uma string JSON (o `payment.json()` do LNbits 1.6). Precisa ter `payment_hash` ou `checking_id`. O resto do corpo não liquida nada. O motor lê o pagamento na API do LNbits.

Resposta quando liquida:

```json
{ "status": "pago", "valor": "10000", "id_transacao": "pedido-123" }
```

Outros `status`: `ignorado` (não pago, valor ausente ou que não bate, ou cobrança cancelada), `ja_processado` (já estava pago; a segunda entrega do mesmo hash para aqui), `desconhecido` (hash que não é de cobrança deste motor).

Valor abaixo da invoice, valor que não bate nem como sats nem como msat, ou valor ausente: a cobrança continua como estava e o operador é alertado uma vez.

---

## Admin

Todas as rotas abaixo exigem `Authorization: Bearer {ADMIN_TOKEN}`. Sem HMAC.

### Criar cliente

`POST /admin/api/clients`

```json
{ "name": "Loja Centro", "webhook_url": "https://loja.example/webhooks/motor" }
```

`name` de 1 a 80. `webhook_url` tem de ser URL http(s). Em produção, só https.

Resposta **201**. Os três segredos aparecem só aqui:

```json
{
  "id": "uuid",
  "name": "Loja Centro",
  "webhookUrl": "https://loja.example/webhooks/motor",
  "apiKey": "mk_btc_live_...",
  "requestSecret": "...",
  "webhookSecret": "...",
  "createdAt": "2026-10-29T12:00:00.000Z"
}
```

`apiKey` vai no `Authorization` da loja. `requestSecret` é a chave do HMAC de entrada. `webhookSecret` é a chave do HMAC de saída. Não há rota para lê-los de novo.

### Listar clientes

`GET /admin/api/clients`

Não devolve segredo. Devolve `id`, `name`, `apiKeyPrefix` (os primeiros 20 caracteres da key), `webhookUrl`, `status` (`ativo` ou `inativo`) e `createdAt`.

### Status da operação

`GET /admin/api/status`

```json
{
  "ok": true,
  "intents": { "pendente": 4, "pago": 12 },
  "webhooks": { "pendente": 1, "entregue": 20 },
  "sweeps": { "sweepado": 9, "manual": 1 },
  "pendingIntents": 4,
  "dueWebhooks": 1,
  "activeSweeps": 0,
  "clientBalances": [
    {
      "clientId": "uuid",
      "name": "Loja Centro",
      "paidRail": "lightning",
      "paidAmountSats": "50000"
    },
    {
      "clientId": "uuid",
      "name": "Loja Centro",
      "paidRail": "onchain",
      "paidAmountSats": "10000"
    }
  ],
  "lnbits": { "ok": true },
  "esplora": { "ok": true },
  "network": "bitcoin",
  "xpubFingerprint": "abcd1234",
  "signerMode": "local",
  "sweepEnabled": true,
  "uptimeSeconds": 3600
}
```

`clientBalances` soma `paid_amount_sats` das intents `pago` e `pago_tardio`, agrupado por cliente e por `paid_rail`. É o relatório do que está misturado na carteira fria e na wallet do LNbits. Não move fundo.

As contagens de `intents`, `webhooks` e `sweeps` são o `GROUP BY status` de cada tabela. Chave ausente significa zero.

### Webhooks

`GET /admin/api/webhooks?limit=50`

`limit` de 1 a 200, padrão 50. Cada item é a linha do outbox: id, cliente, intent, tipo, payload, status (`pendente`, `entregue`, `falhou`), tentativas, próximo horário, último erro.

`POST /admin/api/webhooks/:id/replay`

Zera tentativas, limpa o erro, volta o status para `pendente` e devolve a linha. 404 se o id não existe. O worker entrega no próximo ciclo.

### Sweeps

`GET /admin/api/sweeps?limit=50`

Mesma regra de `limit`. Cada item traz status, txid, valor, taxa, inputs, tentativas, último erro, PSBT e raw quando existirem.

Status que aparecem: `pendente`, `construindo`, `assinando`, `transmitindo`, `aguardando_confirmacao_rede`, `sweepado`, `falhou`, `manual`, `substituido`, `nao_aplicavel`, `aguardando_confirmacao`. Os que a operação vê no dia a dia são `construindo`, `aguardando_confirmacao_rede`, `sweepado`, `falhou` e `manual`.

`POST /admin/api/sweeps/:id/retry`

- Sweep `sweepado`: 409, não há o que reenviar.
- Tem txid e o Esplora mostra o tx confirmado: 409.
- Tem txid e o tx ainda está na mempool: 409. Espere o RBF. A rota não monta um segundo gasto dos mesmos inputs.
- Tem txid e o Esplora responde 404: restaura as saídas de `gasto` para `confirmado`, marca o sweep `falhou` com tentativas zeradas, e o próximo ciclo tenta de novo.
- Não tem txid: o mesmo restore, porque o broadcast não chegou a acontecer.
- A API subiu sem cliente Esplora e o sweep tem txid: 409, retry recusado.

---

## Saúde

`GET /health`

```json
{ "ok": true, "service": "btc-payments", "version": "0.1.0", "ts": "2026-10-29T12:00:00.000Z" }
```

Não consulta banco nem LNbits. Serve para o processo estar de pé.

`GET /ready`

200 se todos os checks passam. 503 se algum falha. O corpo traz `ok`, `checks` e `ts`.

| check | Passa quando |
| --- | --- |
| `db` | `select 1` no Postgres |
| `xpub` | O xpub deriva o endereço de índice 0 na rede configurada |
| `cold_wallet` | Sweep desligado, ou `COLD_WALLET_ADDRESS` é um endereço dessa rede |
| `lnbits` | A API do LNbits responde |
| `esplora` | O Esplora responde, com a altura da ponta |

---

## Portal, auth e checkout público

Alem da API HMAC, o serviço expõe um portal para o lojista (cookie de sessão) e
uma página pública de checkout. O manual completo está em
[`services/btc-payments/docs/manual.md`](../services/btc-payments/docs/manual.md).

| Quem | Prefixo | Credencial |
| --- | --- | --- |
| Lojista (portal) | `POST /auth/*`, `GET/POST/PATCH/DELETE /v1/portal/*` | Cookie `portal_sid` + `X-CSRF-Token` nas mutações |
| Pagador | `GET /pay/:id`, `GET /pay/:id/status` | nenhuma |

Auth: `POST /auth/register`, `POST /auth/login`, `POST /auth/verify-email`,
`POST /auth/logout`, `GET /auth/me`, `POST /auth/forgot-password`,
`POST /auth/reset-password`, `POST /auth/change-password`. O cadastro cria a
conta **e** a primeira loja (`unverified`).

Lojas/carteiras/checkout/relatórios/assinaturas ficam em
`/v1/portal/merchants/:id/...` — isolados por `merchant_members` (outra loja
responde 403). Assinaturas recorrentes ficam em
`/v1/portal/merchants/:id/subscriptions`.

A página `/pay/:id` mostra o QR (BIP21 com `lightning=`) e faz poll em
`/pay/:id/status`. O snippet embutível é `/checkout.js`.

---

## O que não chamar nesta porta

Não existem, e devolvem 404:

- `/v1/links`
- `/p/:token`
- `/admin/api/ramp-profiles`
- qualquer rota de cotação, carteira allowlisted ou centavos de real

Essas rotas são do motor legado em `legacy/src/`, porta 4578. O livro atual está em `docs/index.html`.
