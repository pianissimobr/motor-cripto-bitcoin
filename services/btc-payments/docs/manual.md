# Manual do lojista

Guia prático para você, lojista que programa o próprio site, integrar o Motor
Cripto sozinho. O motor **não guarda nem converte** o seu dinheiro: ele gera o
*caminho* do pagamento (QR/invoice) e confirma a chegada; o valor cai direto nas
carteiras que você cadastrar.

Índice:

1. [O modelo em 3 frases](#o-modelo-em-3-frases)
2. [Primeiro acesso](#primeiro-acesso)
3. [Lojas e carteiras](#lojas-e-carteiras)
4. [Credenciais da API](#credenciais-da-api)
5. [Receber via API (HMAC)](#receber-via-api-hmac)
6. [Checkout hospedado + snippet](#checkout-hospedado--snippet)
7. [Webhook de confirmação](#webhook-de-confirmacao)
8. [PIX → USDC](#pix--usdc)
9. [Assinaturas recorrentes](#assinaturas-recorrentes)
10. [Relatórios](#relatorios)
11. [Boas práticas (idempotência, relógio, nonce)](#boas-praticas)
12. [Referência rápida de endpoints](#referencia-rapida)

---

## O modelo em 3 frases

- Você cria uma **cobrança** e mostra o **QR** (Bitcoin on-chain + Lightning) ou
  um **PIX** para o seu cliente.
- O motor **prova** o pagamento e te avisa por **webhook**.
- O dinheiro cai **direto nas suas carteiras**, na moeda em que foi pago:
  Lightning na sua wallet LNbits, on-chain no seu xpub e PIX como USDC na sua
  carteira Polygon. Nada é convertido.

---

## Primeiro acesso

1. Abra `https://SEU-DOMINIO/signup` (ou `/portal`) e crie a conta com e-mail e
   senha.
2. O cadastro cria sua **primeira loja** e devolve **uma única vez**: API key,
   `request_secret` e `webhook_secret`. Copie e guarde.
3. Em desenvolvimento/local, o e-mail de verificação não sai: o token é exibido
   na tela. Copie e use no passo de verificação. Em produção, o serviço precisa
   de um relay SMTP configurado (`EMAIL_SENDER=smtp`, `SMTP_HOST`, `EMAIL_FROM`);
   sem isso o token de redefinição de senha e o aviso de troca de carteira não
   chegam — fale com quem opera o serviço.

Depois de logado, o `https://SEU-DOMINIO/portal` é o seu **dashboard**: troca de
loja, carteiras, criar QR, relatórios e assinaturas.

---

## Lojas e carteiras

Uma conta pode ter **várias lojas** (workspaces). Cada loja tem três tipos de
carteira, um por trilho. O dinheiro cai direto nelas; o motor não guarda nem
converte nada:

| Tipo | Para quê | O que informar |
| --- | --- | --- |
| `lightning_lnbits` | receber Lightning direto na sua wallet LNbits | URL do seu LNbits + **Invoice key** (nunca a Admin key) |
| `btc_deposit` | receber on-chain em endereços derivados do seu xpub | `xpub` de **conta** BIP84 (`m/84'/0'/0'`), **nunca** `xprv`/seed |
| `usdc_settlement` | receber o PIX, já em USDC (a Lunium entrega direto) | endereço `0x...` na Polygon |

No dashboard: **Carteiras → Adicionar**. O endereço USDC é único por loja; o
mesmo endereço em outra loja é recusado (409).

> O `xpub` é a sua **chave pública** de conta. Com ele o motor deriva endereços,
> mas **não** pode gastar. Nunca cole um `xprv`, uma seed ou um mnemonic aqui.

> **Configure o gap limit da sua carteira em 1000** (Sparrow: Settings →
> Advanced → Gap limit; Electrum: `wallet.change_gap_limit(1000)`). Cada
> cobrança usa um endereço novo, inclusive as que expiram sem pagamento.

> **Lightning:** use a **Invoice key** da sua wallet LNbits. A Admin key (que
> gasta o saldo) é recusada no cadastro.

> Toda troca de carteira gera o webhook `merchant.wallet_changed` (e e-mail,
> quando o operador ligar um provedor). Se não foi você, troque a senha.

---

## Credenciais da API

Criar uma loja mostra **uma única vez**:

- `apiKey` (`mk_btc_live_...`) → cabeçalho `Authorization`.
- `requestSecret` → chave do **HMAC** das suas requisições ao motor (o
  `request_secret` deste manual).
- `webhookSecret` → chave do HMAC dos webhooks **enviados para você** (o
  `webhook_secret` deste manual).

Depois, no dashboard você só vê o **prefixo**. Perdeu a chave? Rotacione em
`.../api-key/rotate` (a antiga para de valer na hora).

---

## Receber via API (HMAC)

Toda rota `/v1/*` exige 3 cabeçalhos além do `Authorization`:

```http
Authorization: Bearer mk_btc_live_...
X-Timestamp: 1792700000
X-Nonce: pedido-123-1
X-Signature: v1=0123abcd...
```

A assinatura é `HMAC-SHA256(request_secret, canonica)`, onde:

```text
METHOD
PATH
TIMESTAMP
NONCE
SHA256(corpoCru)
```

- `PATH` **sem** query string.
- `TIMESTAMP` em segundos Unix, com tolerância de ±300 s (mantenha o relógio do
  seu servidor em NTP).
- `NONCE` único por cliente; reusar responde 401.
- O hash assina o **corpo cru** (bytes exatos), mesmo para GET (corpo vazio).

### Exemplo completo (Node, uma cobrança)

```js
import { createHash, createHmac, randomBytes } from 'node:crypto';

const BASE = process.env.MOTOR_BASE;          // https://SEU-DOMINIO
const API_KEY = process.env.MOTOR_API_KEY;    // mk_btc_live_...
const SECRET = process.env.MOTOR_REQUEST_SECRET;

const body = JSON.stringify({
  external_id: 'pedido-123',
  amount_sats: '10000',
  description: 'Pedido 123',
});

const timestamp = Math.floor(Date.now() / 1000).toString();
const nonce = randomBytes(16).toString('hex');
const canonical = ['POST', '/v1/payment-intents', timestamp, nonce,
  createHash('sha256').update(body).digest('hex')].join('\n');
const signature = createHmac('sha256', SECRET).update(canonical).digest('hex');

const res = await fetch(`${BASE}/v1/payment-intents`, {
  method: 'POST',
  headers: {
    'authorization': `Bearer ${API_KEY}`,
    'content-type': 'application/json',
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': `v1=${signature}`,
  },
  body,
});

const data = await res.json();
if (!res.ok) throw new Error(JSON.stringify(data));
console.log(data.qr_svg);          // <svg ...> — mostre esse QR
console.log(data.payment_uri);     // bitcoin:...?lightning=...
console.log(data.id);              // uuid para consultar o status
```

### Em curl (com um helper que assina)

```bash
# variaveis de exemplo
BODY='{"external_id":"pedido-123","amount_sats":"10000"}'
TS=$(date +%s)
NONCE=$(openssl rand -hex 16)
BODYHASH=$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $2}')
CANONICA=$(printf 'POST\n/v1/payment-intents\n%s\n%s\n%s' "$TS" "$NONCE" "$BODYHASH")
SIG=$(printf '%s' "$CANONICA" | openssl dgst -sha256 -hmac "$MOTOR_REQUEST_SECRET" | awk '{print $2}')

curl -s "$MOTOR_BASE/v1/payment-intents" \
  -H "Authorization: Bearer $MOTOR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Timestamp: $TS" -H "X-Nonce: $NONCE" -H "X-Signature: v1=$SIG" \
  -d "$BODY"
```

### Consultar / cancelar

```
GET  /v1/payment-intents/:id
GET  /v1/payment-intents?external_id=pedido-123
POST /v1/payment-intents/:id/cancel       # só quando status = pendente
```

Os status são: `criando`, `pendente`, `pago`, `pago_tardio`, `parcial`,
`expirado`, `cancelado`, `reorg`, `falha_criacao`. `pago` e `pago_tardio` contam
como **recebido**. Use `external_id` como chave de idempotência: repetir o mesmo
valor devolve a mesma cobrança.

---

## Checkout hospedado + snippet

**Sem escrever backend** no seu site, você pode gerar a cobrança no dashboard
(**Criar checkout**) e usar:

1. **Página hospedada** — o dashboard gera `https://SEU-DOMINIO/pay/<id>`. Você
   envia esse link (e-mail, WhatsApp, botão).
2. **Snippet** — inclua uma vez no `<head>` do seu site e marque qualquer botão:

```html
<script src="https://SEU-DOMINIO/checkout.js" defer></script>
<button data-motor-checkout="<id-da-cobranca>">Pagar</button>
```

O script abre a página de pagamento numa janela. Também dá para chamar em JS:

```js
MotorCheckout.open('<id-da-cobranca>');
```

A página mostra o QR (já com Lightning) e atualiza o status sozinha. O status em
JSON (para o seu JS/iframe) fica em `GET /pay/<id>/status`.

> O `id` é o `id` (uuid) da cobrança. Ele é o token da página: não é adivinhável.
> Não exponha `request_secret`/`webhook_secret` no frontend — para a página
> pública só o `id` é necessário.

---

## Webhook de confirmação

Configure a `webhook_url` da loja no portal (ou na criação). Quando o pagamento
chega a um estado final, o motor faz `POST` nela com:

```http
Content-Type: application/json
User-Agent: btc-payments-webhook/1
X-Webhook-Signature: t=1792700000,v1=0123abcd...
X-Webhook-Event: payment_intent.paid
X-Webhook-Delivery: <event_id>
```

Corpo em `{ "event", "event_id", "created_at", "data": { "external_id",
"status", "amount_sats", "paid_amount_sats", "paid_rail", "paid_at",
"overpaid_sats" } }`.

Valide a assinatura com o `webhook_secret`: `HMAC-SHA256(secret, "<t>.<corpoCru>")`.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function ok(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(parts.v1, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- **Responda 2xx** para marcar entregue; se não, o motor tenta de novo (backoff,
  até `WEBHOOK_MAX_ATTEMPTS`).
- Guarde `event_id` / `X-Webhook-Delivery` para deduplicar: o mesmo evento pode
  chegar duas vezes se a sua resposta demorar.
- Eventos: `payment_intent.paid`, `.paid_late`, `.partial`, `.expired`,
  `.canceled`, `.reorged`, e, no PIX, `pix_charge.paid` / `pix_charge.settled`.

---

## PIX → USDC

Se habilitado, `POST /v1/pix-charges` cria um PIX que entrega USDC **na
Polygon** (a rede que a chave da Lunium usa):

```json
{
  "external_id": "pedido-123",
  "amount": "50.00",
  "currency": "BRL",
  "payer_tax_number": "00000000191",
  "payer_name": "Cliente"
}
```

A resposta traz `pix.qr_copypaste`, `pix.qr_image_url` (ou `qr_svg`). O
CPF/CNPJ é exigido pela provedora (PIX) e **não** é guardado em texto claro.

**A carteira `usdc_settlement` é obrigatória**: sem ela a cobrança não é criada
(409 `settlement_wallet_required`). A Lunium entrega o USDC **direto** nela —
a plataforma não custodia esse valor.

### O que o pagador vai ver

O QR é da Lunium (é quem recebe o Pix e quem entrega o USDC). O pagador paga
o valor exato; a Lunium confere o CPF/CNPJ informado antes de entregar, e pode
levar alguns minutos para liberar (estado `under_review`). Se o documento
divergir do pagador, o valor é devolvido e nada é creditado.

### Limites (leia da chave, nunca fixe)

| Limite | Valor na chave de produção |
|---|---|
| Cash-in por cobrança | R$ 1,02 – R$ 6.000,00 |
| Cash-in mínimo na rota USDC/Polygon | R$ 6,90 |
| Cash-out por transação | R$ 6,00 – R$ 250.000,00 (sem teto diário) |
| Cash-in do pagador (1ª transação) | R$ 100,00 |

`GET /keys/me` → `limits` e `GET /cashin/limits?payer_tax=` trazem os valores
vigentes. Uma operação real de R$ 10,00 entregou **1,558020 USDC** (taxa de
R$ 1,30) cerca de 4 minutos depois do Pix cair.

---

## Assinaturas recorrentes

No dashboard (**Assinaturas**), você cria um plano (valor em sats + ciclo
diário/semanal/mensal). O worker gera uma **nova cobrança a cada ciclo** e a
confirmação sai pelo webhook normal, com o `external_id` do ciclo
(`sub_<id>_<fim-do-ciclo>`) e `metadata.subscription_id`. Não existe débito em
conta: cada ciclo é um pagamento novo que o cliente aprova.

---

## Relatórios

No dashboard, ou via API de sessão:

```
GET /v1/portal/merchants/:id/reports/summary?period=7d|30d|all
GET /v1/portal/merchants/:id/reports/by-rail
GET /v1/portal/merchants/:id/reports/series
```

`summary` devolve volume (sats), volume por rail (Lightning × on-chain × PIX),
quantidade de QRs, pagos, expirados e o valor já pago para você (USDC).

---

## Boas práticas

- **Idempotência**: mande sempre um `external_id` estável por pedido. Retry da
  sua parte usa *outro nonce*, mas *mesmo external_id*.
- **Relógio**: mantenha NTP. `X-Timestamp` fora de ±300 s responde 401.
- **Segredos**: `request_secret` e `webhook_secret` só no seu backend. A página
  pública usa apenas o `id` da cobrança.
- **Webhook**: valide o HMAC e use `event_id` para deduplicar.
- **Não guarde a API key no frontend**; qualquer vazamento rotaciona.

---

## Referência rápida

| Uso | Endpoint |
| --- | --- |
| Criar cobrança | `POST /v1/payment-intents` |
| Consultar | `GET /v1/payment-intents/:id` ou `?external_id=` |
| Cancelar | `POST /v1/payment-intents/:id/cancel` |
| Cobrança PIX | `POST /v1/pix-charges` |
| Carteiras | `GET/POST /v1/wallets` |
| Saldos (ledger) | `GET /v1/balances` |
| Página pública | `GET /pay/:id` e `GET /pay/:id/status` |
| Snippet | `/checkout.js` |
| Portal/lojas | `/v1/portal/merchants/...` |
| Assinaturas | `/v1/portal/merchants/:id/subscriptions` |
| Relatórios | `/v1/portal/merchants/:id/reports/*` |

Contrato completo (corpos e códigos): [`docs/API.md`](../../../docs/API.md).