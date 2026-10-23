# API do Motor Cripto

Referência completa da API HTTP do motor de pagamentos on-chain.

- **Base local:** `http://localhost:4578`
- **Base de produção:** o valor de `PUBLIC_BASE_URL`
- **Formato:** JSON (`application/json`)
- **Versão do contrato do cliente:** `/v1`
- **Moeda fiat:** sempre inteiro em centavos (`10000` = R$ 100,00)
- **Token:** sempre string em base units (`"18000000"` = 18 USDC com 6 decimais)
- **Datas:** ISO 8601 em UTC

## Índice

1. [Fluxo da integração](#1-fluxo-da-integração)
2. [Autenticação](#2-autenticação)
3. [Início rápido](#3-início-rápido)
4. [API do cliente `/v1`](#4-api-do-cliente-v1)
5. [Página pública](#5-página-pública)
6. [Webhooks](#6-webhooks)
7. [Status do link](#7-status-do-link)
8. [API administrativa](#8-api-administrativa)
9. [Erros e limites](#9-erros-e-limites)
10. [Exemplo completo em Node](#10-exemplo-completo-em-node)

---

## 1. Fluxo da integração

```
1. Admin cria o cliente da API
   POST /admin/api/clientes

2. Admin cadastra a carteira de destino allowlisted
   POST /admin/api/clientes/:id/wallets

3. Cliente consulta perfis Ramp e carteiras
   GET /v1/ramp-profiles
   GET /v1/wallets

4. Cliente cria o link
   POST /v1/links

5. Comprador abre page_url e paga pela Ramp/on-chain

6. Motor confirma o pagamento e envia webhook
   POST https://seu-sistema.example/webhooks/motor

7. Motor varre o valor para a carteira allowlisted
```

O endereço de depósito é sempre derivado pelo servidor. O cliente **não envia
endereço de depósito**; ele escolhe uma carteira allowlisted previamente
cadastrada e envia o `wallet_id` no corpo de `POST /v1/links`.

---

## 2. Autenticação

Existem dois tipos de autenticação:

| Área | Rotas | Credencial |
|---|---|---|
| Cliente da API | `/v1/*` | API key + assinatura HMAC |
| Admin | `/admin/api/*` | `ADMIN_TOKEN` |
| Pública | `/health`, `/p/:token` | nenhuma |

### 2.1 Admin

Toda requisição administrativa usa:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Exemplo:

```bash
curl -sS http://localhost:4578/admin/api/status \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

O `ADMIN_TOKEN` não assina o corpo. Ele é um bearer token comum. Em produção,
use HTTPS e mantenha o token apenas no servidor/operador.

### 2.2 Cliente da API (`/v1`)

Toda requisição para `/v1/*` precisa dos headers de autenticação abaixo. Se
houver corpo JSON, inclua também `Content-Type: application/json`:

```http
Authorization: Bearer mk_live_...
X-Timestamp: 1792700000
X-Nonce: 3f4c2d1e-um-valor-unico
X-Signature: v1=<hex>
Content-Type: application/json
```

Regras:

- `X-Timestamp`: Unix epoch em segundos. Aceito dentro de ±300 segundos.
- `X-Nonce`: 8 a 128 caracteres, único por cliente. Um nonce reutilizado retorna `409`.
- `X-Signature`: HMAC-SHA256 em hexadecimal, prefixado com `v1=`.
- O corpo assinado é o **JSON exato enviado**, sem reserializar.
- Para `GET` ou `POST` sem corpo, o hash do corpo é o SHA-256 da string vazia.

String canônica:

```text
METHOD
PATH
TIMESTAMP
NONCE
SHA256(RAW_BODY)
```

- `METHOD` em maiúsculas.
- `PATH` sem query string. Exemplo: `/v1/links?limit=10` assina `/v1/links`.
- `SHA256(RAW_BODY)` em hexadecimal minúsculo.

Assinatura:

```text
HMAC-SHA256(request_secret, canônica)
```

#### Exemplo com shell + OpenSSL

```bash
BASE="http://localhost:4578"
API_KEY="mk_live_..."
REQUEST_SECRET="req_..."

signed() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local query="${4:-}"
  local ts nonce body_hash canonical signature url

  ts="$(date +%s)"
  nonce="$(openssl rand -hex 16)"
  body_hash="$(printf '%s' "$body" | openssl dgst -sha256 -hex | awk '{print $NF}')"
  canonical="$(printf '%s\n%s\n%s\n%s\n%s' "$method" "$path" "$ts" "$nonce" "$body_hash")"
  signature="$(printf '%s' "$canonical" | openssl dgst -sha256 -hmac "$REQUEST_SECRET" -hex | awk '{print $NF}')"

  url="$BASE$path"
  if [ -n "$query" ]; then
    url="$url?$query"
  fi

  if [ -n "$body" ]; then
    curl -sS -X "$method" "$url" \
      -H "Authorization: Bearer $API_KEY" \
      -H "X-Timestamp: $ts" \
      -H "X-Nonce: $nonce" \
      -H "X-Signature: v1=$signature" \
      -H "Content-Type: application/json" \
      --data-binary "$body"
  else
    curl -sS -X "$method" "$url" \
      -H "Authorization: Bearer $API_KEY" \
      -H "X-Timestamp: $ts" \
      -H "X-Nonce: $nonce" \
      -H "X-Signature: v1=$signature"
  fi
}
```

Uso:

```bash
signed GET /v1/ramp-profiles
signed GET /v1/links "" "limit=10"
signed POST /v1/links '{"external_id":"pedido-1","amount_cents":10000,"ramp_profile_id":"UUID_DO_PERFIL","wallet_id":"UUID_DA_CARTEIRA"}'
```

O terceiro argumento é o corpo; o quarto é a query string. A assinatura usa
somente `path`, sem a query.

### 2.3 Rotação de credenciais

- `POST /admin/api/clientes/:id/rotate-key` gera nova `api_key` e novo
  `request_secret`. A credencial antiga deixa de funcionar imediatamente.
- `POST /admin/api/clientes/:id/rotate-webhook-secret` gera novo
  `webhook_secret` para validar webhooks.
- Os segredos aparecem **uma única vez** na resposta da criação/rotação.

---

## 3. Início rápido

### 3.1 Criar cliente da API

```bash
curl -sS -X POST http://localhost:4578/admin/api/clientes \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nome": "Loja Exemplo",
    "webhook_url": "https://loja.example/webhooks/motor"
  }'
```

Resposta `201`:

```json
{
  "data": {
    "id": "11111111-1111-4111-8111-111111111111",
    "nome": "Loja Exemplo",
    "api_key_prefix": "mk_live_abc1234",
    "webhook_url": "https://loja.example/webhooks/motor",
    "status": "ativo",
    "criado_em": "2026-10-23T15:00:00.000Z"
  },
  "api_key": "mk_live_...",
  "request_secret": "req_...",
  "webhook_secret": "whsec_..."
}
```

Guarde `api_key`, `request_secret` e `webhook_secret` agora. Eles não são
mostrados novamente.

### 3.2 Cadastrar a carteira de destino

```bash
curl -sS -X POST http://localhost:4578/admin/api/clientes/11111111-1111-4111-8111-111111111111/wallets \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Carteira principal",
    "chain": "polygon",
    "address": "0x1111111111111111111111111111111111111111"
  }'
```

Resposta `201`:

```json
{
  "data": {
    "id": "22222222-2222-4222-8222-222222222222",
    "api_cliente_id": "11111111-1111-4111-8111-111111111111",
    "label": "Carteira principal",
    "chain": "polygon",
    "address": "0x1111111111111111111111111111111111111111",
    "criado_em": "2026-10-23T15:01:00.000Z"
  }
}
```

### 3.3 Consultar perfis e carteiras

```bash
signed GET /v1/ramp-profiles
signed GET /v1/wallets
```

Use o `id` do perfil como `ramp_profile_id` e o `id` da carteira como
`wallet_id` na criação do link.

### 3.4 Criar o link

```bash
signed POST /v1/links '{
  "external_id": "pedido-123",
  "amount_cents": 10000,
  "ramp_profile_id": "33333333-3333-4333-8333-333333333333",
  "wallet_id": "22222222-2222-4222-8222-222222222222",
  "final_url": "https://loja.example/obrigado"
}'
```

Resposta `201`:

```json
{
  "data": {
    "id": "44444444-4444-4444-8444-444444444444",
    "external_id": "pedido-123",
    "status": "aguardando",
    "motivo_nao_realizado": null,
    "valor_fiat_centavos": 10000,
    "moeda_fiat": "BRL",
    "chain": "polygon",
    "asset": "USDC",
    "token_contract": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    "decimals": 6,
    "expected_base_units": "18000000",
    "valor_recebido_base_units": "0",
    "endereco_deposito": "0x5555555555555555555555555555555555555555",
    "wallet_address": "0x1111111111111111111111111111111111111111",
    "expira_em": "2026-10-23T16:01:00.000Z",
    "liquidacao_ate": "2026-10-24T16:01:00.000Z",
    "reembolsado": false,
    "criado_em": "2026-10-23T15:01:00.000Z",
    "page_url": "https://pay.example/p/token-opaco"
  },
  "reused": false
}
```

Envie `page_url` ao comprador. Não envie `endereco_deposito` manualmente; a
página já mostra o endereço e o link da Ramp.

---

## 4. API do cliente `/v1`

Todas as rotas abaixo exigem API key + HMAC, exceto quando indicado.

### 4.1 Criar link

```http
POST /v1/links
```

Headers:

```http
Authorization: Bearer mk_live_...
X-Timestamp: 1792700000
X-Nonce: 3f4c2d1e-um-valor-unico
X-Signature: v1=...
Content-Type: application/json
Idempotency-Key: pedido-123
```

Corpo:

```json
{
  "external_id": "pedido-123",
  "amount_cents": 10000,
  "ramp_profile_id": "33333333-3333-4333-8333-333333333333",
  "wallet_id": "22222222-2222-4222-8222-222222222222",
  "final_url": "https://loja.example/obrigado"
}
```

Campos:

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `external_id` | string | sim | 1 a 200 caracteres; único por cliente |
| `amount_cents` | inteiro | sim | positivo, máximo `100000000` |
| `ramp_profile_id` | UUID | sim | perfil ativo retornado por `/v1/ramp-profiles` |
| `wallet_id` | UUID | sim | carteira allowlisted do próprio cliente |
| `final_url` | string/null | não | URL `http(s)` de retorno após o pagamento |

Resposta `201` (criação) ou `200` (idempotência):

```json
{
  "data": {
    "id": "44444444-4444-4444-8444-444444444444",
    "external_id": "pedido-123",
    "status": "aguardando",
    "motivo_nao_realizado": null,
    "valor_fiat_centavos": 10000,
    "moeda_fiat": "BRL",
    "chain": "polygon",
    "asset": "USDC",
    "token_contract": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    "decimals": 6,
    "expected_base_units": "18000000",
    "valor_recebido_base_units": "0",
    "endereco_deposito": "0x5555555555555555555555555555555555555555",
    "wallet_address": "0x1111111111111111111111111111111111111111",
    "expira_em": "2026-10-23T16:01:00.000Z",
    "liquidacao_ate": "2026-10-24T16:01:00.000Z",
    "reembolsado": false,
    "criado_em": "2026-10-23T15:01:00.000Z",
    "page_url": "https://pay.example/p/token-opaco"
  },
  "reused": false
}
```

#### Idempotência

- Chave usada: header `Idempotency-Key`; se ausente, `external_id`.
- Mesma chave + mesmo payload: retorna `200` com `reused: true` e o link original.
- Mesma chave + payload diferente: retorna `409 idempotencia_conflitante`.
- `external_id` também é único por cliente.
- O payload comparado inclui `external_id`, `amount_cents`, `ramp_profile_id`,
  `wallet_id` e `final_url`.

Erros comuns:

| HTTP | Código | Quando |
|---|---|---|
| `400` | `dados_invalidos` | corpo inválido, carteira de outro cliente ou chain incompatível |
| `404` | `nao_encontrado` | perfil Ramp inexistente |
| `409` | `idempotencia_conflitante` | mesma chave com outro payload |

### 4.2 Listar links

```http
GET /v1/links?limit=50
```

Query:

| Parâmetro | Padrão | Limite |
|---|---|---|
| `limit` | `50` | 1 a 200 |

Resposta `200`:

```json
{
  "data": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "external_id": "pedido-123",
      "status": "aguardando",
      "motivo_nao_realizado": null,
      "valor_fiat_centavos": 10000,
      "moeda_fiat": "BRL",
      "chain": "polygon",
      "asset": "USDC",
      "token_contract": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      "decimals": 6,
      "expected_base_units": "18000000",
      "valor_recebido_base_units": "0",
      "endereco_deposito": "0x5555555555555555555555555555555555555555",
      "wallet_address": "0x1111111111111111111111111111111111111111",
      "expira_em": "2026-10-23T16:01:00.000Z",
      "liquidacao_ate": "2026-10-24T16:01:00.000Z",
      "reembolsado": false,
      "criado_em": "2026-10-23T15:01:00.000Z",
      "page_url": "https://pay.example/p/token-opaco"
    }
  ]
}
```

### 4.3 Consultar link

```http
GET /v1/links/44444444-4444-4444-8444-444444444444
```

Resposta `200`: o mesmo objeto `data` da criação.

Erro: `404 nao_encontrado` se o link não pertence ao cliente autenticado.

### 4.4 Revogar link

```http
POST /v1/links/44444444-4444-4444-8444-444444444444/revoke
```

Sem corpo. A assinatura usa o SHA-256 da string vazia.

Resposta `200`:

```json
{
  "data": {
    "id": "44444444-4444-4444-8444-444444444444",
    "external_id": "pedido-123",
    "status": "nao_realizado",
    "motivo_nao_realizado": "revogado",
    "valor_fiat_centavos": 10000,
    "moeda_fiat": "BRL",
    "chain": "polygon",
    "asset": "USDC",
    "token_contract": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    "decimals": 6,
    "expected_base_units": "18000000",
    "valor_recebido_base_units": "0",
    "endereco_deposito": "0x5555555555555555555555555555555555555555",
    "wallet_address": "0x1111111111111111111111111111111111111111",
    "expira_em": "2026-10-23T16:01:00.000Z",
    "liquidacao_ate": "2026-10-24T16:01:00.000Z",
    "reembolsado": false,
    "criado_em": "2026-10-23T15:01:00.000Z",
    "page_url": "https://pay.example/p/token-opaco"
  }
}
```

Regras:

- Link `aguardando`, `expirado` ou `parcial`: vira `nao_realizado` com motivo `revogado`.
- Link `pago` ou `pago_sem_gas`: `409 link_ja_pago`.
- Link `nao_realizado` ou `movido`: retorna o estado atual sem erro.

### 4.5 Listar perfis Ramp

```http
GET /v1/ramp-profiles
```

Resposta `200`:

```json
{
  "data": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "label": "Polygon USDC",
      "chain": "polygon",
      "asset": "USDC",
      "token_contract": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      "decimals": 6,
      "fiat_currency": "BRL",
      "base_url": "https://buy.ramp.network/",
      "param_style": "legacy",
      "host_app_name": "Motor Cripto",
      "host_logo_url": null,
      "ramp_asset_key": "POLYGON_USDC",
      "taxa_token_por_fiat_base_units": "180000",
      "criado_em": "2026-10-23T14:00:00.000Z"
    }
  ]
}
```

`taxa_token_por_fiat_base_units` é a taxa usada para calcular
`expected_base_units`. `null` significa que o motor não consegue classificar
valor parcial para esse perfil.

### 4.6 Listar carteiras allowlisted

```http
GET /v1/wallets
```

Resposta `200`:

```json
{
  "data": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "api_cliente_id": "11111111-1111-4111-8111-111111111111",
      "label": "Carteira principal",
      "chain": "polygon",
      "address": "0x1111111111111111111111111111111111111111",
      "criado_em": "2026-10-23T15:01:00.000Z"
    }
  ]
}
```

O `wallet_id` retornado aqui é o valor enviado no corpo de `POST /v1/links`.

---

## 5. Página pública

### 5.1 Abrir página de pagamento

```http
GET /p/:token
```

- Sem autenticação.
- Retorna HTML.
- Mostra valor, status, QR code, endereço de depósito e botão da Ramp.
- O token é um segredo bearer; não deve ser registrado em logs de terceiros.

Erro: `404` com HTML simples se o token não existir.

### 5.2 Consultar status da página

```http
GET /p/:token/status
```

- Sem autenticação.
- Retorna JSON.
- `Cache-Control: no-store`.

Resposta `200`:

```json
{
  "status": "aguardando",
  "motivo_nao_realizado": null,
  "valor_fiat_centavos": 10000,
  "moeda_fiat": "BRL",
  "valor_recebido_base_units": "0",
  "expira_em": "2026-10-23T16:01:00.000Z",
  "liquidacao_ate": "2026-10-24T16:01:00.000Z"
}
```

Erro: `404 { "erro": "pagina nao encontrada" }`.

### 5.3 Health check

```http
GET /health
```

Sem autenticação.

Resposta `200`:

```json
{
  "ok": true,
  "ts": "2026-10-23T15:00:00.000Z"
}
```

---

## 6. Webhooks

O motor envia `POST` para o `webhook_url` cadastrado no cliente quando o link
chega a um estado final.

Eventos:

| `event` no corpo | Header `x-webhook-event` | Quando |
|---|---|---|
| `link.realizado` | `realizado` | `pago`, `pago_sem_gas` ou `movido` |
| `link.nao_realizado` | `nao_realizado` | `nao_realizado` |

Um mesmo link pode gerar mais de um webhook conforme avança de status. Use
`event_id` para idempotência e o `status` para decidir o efeito no seu sistema.

### 6.1 Headers

```http
Content-Type: application/json
User-Agent: motor-cripto-webhook/1
x-webhook-signature: t=1792700000,v1=<hex>
x-webhook-event: realizado
x-webhook-delivery: 66666666-6666-4666-8666-666666666666
```

### 6.2 Corpo

```json
{
  "event": "link.realizado",
  "event_id": "66666666-6666-4666-8666-666666666666",
  "created_at": "2026-10-23T15:05:00.000Z",
  "data": {
    "link_id": "44444444-4444-4444-8444-444444444444",
    "external_id": "pedido-123",
    "status": "pago",
    "motivo_nao_realizado": null,
    "valor_fiat_centavos": 10000,
    "moeda_fiat": "BRL",
    "valor_recebido_base_units": "18000000",
    "chain": "polygon",
    "asset": "USDC",
    "wallet_address": "0x1111111111111111111111111111111111111111",
    "expira_em": "2026-10-23T16:01:00.000Z",
    "liquidacao_ate": "2026-10-24T16:01:00.000Z"
  }
}
```

### 6.3 Validar a assinatura

A assinatura cobre o timestamp e o corpo bruto:

```text
HMAC-SHA256(webhook_secret, "<t>.<raw_body>")
```

Exemplo em Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(secret, signatureHeader, rawBody) {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [key, ...rest] = part.trim().split('=');
      return [key, rest.join('=')];
    }),
  );

  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const provided = parts.v1 ?? '';
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}
```

Use o corpo bruto recebido, não `JSON.stringify(req.body)`.

### 6.4 Retentativas

- Resposta `2xx`: entregue.
- Resposta não `2xx`, timeout ou erro de rede: falha e reagenda.
- Backoff: 60s, 5min, 30min, 2h, 6h, 24h.
- Após `WEBHOOK_MAX_ATTEMPTS` (padrão 6), o evento fica `falhou`.
- O admin pode reenviar com `POST /admin/api/webhooks/:id/replay`.

O motor considera o webhook entregue apenas com HTTP `2xx`. Responda rápido e
processe de forma assíncrona se necessário.

---

## 7. Status do link

| Status | Significado |
|---|---|
| `aguardando` | Página ativa; nenhum pagamento confirmado ainda |
| `expirado` | Página venceu; janela on-chain ainda está aberta |
| `parcial` | Valor recebido abaixo do esperado durante a janela |
| `pago` | Valor cheio confirmado on-chain |
| `pago_sem_gas` | Valor recebido, mas ainda sem gas para o sweep |
| `movido` | Valor varrido para a carteira allowlisted do cliente |
| `nao_realizado` | Estado terminal: sem pagamento, parcial, atrasado, revogado ou reorg |

Motivos de `nao_realizado`:

| Motivo | Significado |
|---|---|
| `nao_pago` | Nenhum pagamento confirmado até o fim da janela |
| `valor_parcial` | Valor recebido abaixo do esperado |
| `pagamento_apos_prazo` | Pagamento chegou depois de `liquidacao_ate` |
| `revogado` | Link revogado pelo cliente/admin |
| `reorg` | Pagamento revertido pela rede |

`nao_realizado` é terminal. Dinheiro que chega depois ainda é registrado e
varrido para a carteira allowlisted, mas o status não muda.

Transições principais:

```text
aguardando -> expirado -> pago | parcial | pago_sem_gas | nao_realizado
aguardando -> pago | parcial | pago_sem_gas | nao_realizado
pago       -> movido | nao_realizado
pago_sem_gas -> movido | nao_realizado
nao_realizado -> (terminal)
```

---

## 8. API administrativa

Base: `/admin/api`

Interface web: `/admin/` (informe o `ADMIN_TOKEN`; ele fica apenas na sessão
do navegador).

Autenticação:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Todas as respostas usam `{ "data": ... }`, salvo quando indicado.

Padrão de chamada com corpo:

```bash
curl -sS -X POST "http://localhost:4578/admin/api/..." \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"campo":"valor"}'
```

### 8.1 Clientes

#### Criar cliente

```http
POST /admin/api/clientes
Content-Type: application/json
```

Corpo:

```json
{
  "nome": "Loja Exemplo",
  "webhook_url": "https://loja.example/webhooks/motor"
}
```

Resposta `201`:

```json
{
  "data": {
    "id": "11111111-1111-4111-8111-111111111111",
    "nome": "Loja Exemplo",
    "api_key_prefix": "mk_live_abc1234",
    "webhook_url": "https://loja.example/webhooks/motor",
    "status": "ativo",
    "criado_em": "2026-10-23T15:00:00.000Z"
  },
  "api_key": "mk_live_...",
  "request_secret": "req_...",
  "webhook_secret": "whsec_..."
}
```

#### Listar clientes

```http
GET /admin/api/clientes
```

```json
{
  "data": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "nome": "Loja Exemplo",
      "api_key_prefix": "mk_live_abc1234",
      "webhook_url": "https://loja.example/webhooks/motor",
      "status": "ativo",
      "criado_em": "2026-10-23T15:00:00.000Z"
    }
  ]
}
```

#### Consultar cliente

```http
GET /admin/api/clientes/:id
```

Resposta inclui `wallets`:

```json
{
  "data": {
    "id": "11111111-1111-4111-8111-111111111111",
    "nome": "Loja Exemplo",
    "api_key_prefix": "mk_live_abc1234",
    "webhook_url": "https://loja.example/webhooks/motor",
    "status": "ativo",
    "criado_em": "2026-10-23T15:00:00.000Z",
    "wallets": [
      {
        "id": "22222222-2222-4222-8222-222222222222",
        "api_cliente_id": "11111111-1111-4111-8111-111111111111",
        "label": "Carteira principal",
        "chain": "polygon",
        "address": "0x1111111111111111111111111111111111111111",
        "criado_em": "2026-10-23T15:01:00.000Z"
      }
    ]
  }
}
```

#### Atualizar cliente

```http
PATCH /admin/api/clientes/:id
Content-Type: application/json
```

Corpo com pelo menos um campo:

```json
{
  "nome": "Loja Exemplo 2",
  "webhook_url": "https://loja.example/webhooks/motor-v2",
  "status": "ativo"
}
```

`status`: `ativo` ou `inativo`.

#### Rotacionar API key

```http
POST /admin/api/clientes/:id/rotate-key
```

Resposta:

```json
{
  "data": {
    "id": "11111111-1111-4111-8111-111111111111",
    "nome": "Loja Exemplo",
    "api_key_prefix": "mk_live_def5678",
    "webhook_url": "https://loja.example/webhooks/motor",
    "status": "ativo",
    "criado_em": "2026-10-23T15:00:00.000Z"
  },
  "api_key": "mk_live_...",
  "request_secret": "req_..."
}
```

#### Rotacionar segredo de webhook

```http
POST /admin/api/clientes/:id/rotate-webhook-secret
```

Resposta:

```json
{
  "data": {
    "id": "11111111-1111-4111-8111-111111111111",
    "nome": "Loja Exemplo",
    "api_key_prefix": "mk_live_abc1234",
    "webhook_url": "https://loja.example/webhooks/motor",
    "status": "ativo",
    "criado_em": "2026-10-23T15:00:00.000Z"
  },
  "webhook_secret": "whsec_..."
}
```

### 8.2 Carteiras allowlisted

#### Listar carteiras do cliente

```http
GET /admin/api/clientes/:id/wallets
```

#### Cadastrar carteira

```http
POST /admin/api/clientes/:id/wallets
Content-Type: application/json
```

```json
{
  "label": "Carteira principal",
  "chain": "polygon",
  "address": "0x1111111111111111111111111111111111111111"
}
```

Resposta `201`:

```json
{
  "data": {
    "id": "22222222-2222-4222-8222-222222222222",
    "api_cliente_id": "11111111-1111-4111-8111-111111111111",
    "label": "Carteira principal",
    "chain": "polygon",
    "address": "0x1111111111111111111111111111111111111111",
    "criado_em": "2026-10-23T15:01:00.000Z"
  }
}
```

A chain da carteira precisa ser a mesma do perfil Ramp usado no link.

### 8.3 Perfis Ramp

#### Listar perfis

```http
GET /admin/api/ramp-profiles
```

#### Criar perfil

```http
POST /admin/api/ramp-profiles
Content-Type: application/json
```

```json
{
  "label": "Polygon USDC",
  "chain": "polygon",
  "asset": "USDC",
  "token_contract": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "decimals": 6,
  "fiat_currency": "BRL",
  "base_url": "https://buy.ramp.network/",
  "param_style": "legacy",
  "host_app_name": "Motor Cripto",
  "host_logo_url": null,
  "host_api_key": null,
  "ramp_asset_key": "POLYGON_USDC",
  "taxa_token_por_fiat_base_units": "180000"
}
```

`host_api_key` é aceito na criação, mas nunca é devolvido pela API.

#### Atualizar perfil

```http
PATCH /admin/api/ramp-profiles/:id
Content-Type: application/json
```

Campos atualizáveis:

```json
{
  "label": "Polygon USDC",
  "fiat_currency": "BRL",
  "base_url": "https://buy.ramp.network/",
  "param_style": "legacy",
  "host_app_name": "Motor Cripto",
  "host_logo_url": null,
  "host_api_key": null,
  "ramp_asset_key": "POLYGON_USDC",
  "taxa_token_por_fiat_base_units": "180000"
}
```

`chain`, `asset`, `token_contract` e `decimals` não são alterados por este
endpoint; crie outro perfil se precisar mudar esses campos.

### 8.4 Links

#### Listar links

```http
GET /admin/api/links?limit=50
```

#### Detalhar link

```http
GET /admin/api/links/:id
```

Resposta:

```json
{
  "data": {
    "link": {
      "id": "44444444-4444-4444-8444-444444444444",
      "external_id": "pedido-123",
      "status": "pago",
      "motivo_nao_realizado": null,
      "valor_fiat_centavos": 10000,
      "moeda_fiat": "BRL",
      "chain": "polygon",
      "asset": "USDC",
      "token_contract": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      "decimals": 6,
      "expected_base_units": "18000000",
      "valor_recebido_base_units": "18000000",
      "endereco_deposito": "0x5555555555555555555555555555555555555555",
      "wallet_address": "0x1111111111111111111111111111111111111111",
      "expira_em": "2026-10-23T16:01:00.000Z",
      "liquidacao_ate": "2026-10-24T16:01:00.000Z",
      "reembolsado": false,
      "criado_em": "2026-10-23T15:01:00.000Z",
      "page_url": "https://pay.example/p/token-opaco"
    },
    "payments": [
      {
        "id": "77777777-7777-4777-8777-777777777777",
        "link_id": "44444444-4444-4444-8444-444444444444",
        "tx_hash": "0x...",
        "log_index": 0,
        "de_address": "0x...",
        "para_address": "0x5555555555555555555555555555555555555555",
        "token": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        "valor_base_units": "18000000",
        "confirmacoes": 10,
        "bloco": 12345678,
        "status": "confirmado",
        "detectado_em": "2026-10-23T15:02:00.000Z",
        "confirmado_em": "2026-10-23T15:03:00.000Z"
      }
    ],
    "transfers": [],
    "webhooks": []
  }
}
```

#### Revogar link

```http
POST /admin/api/links/:id/revoke
```

Sem corpo. Mesmas regras de `POST /v1/links/:id/revoke`.

### 8.5 Webhooks

#### Listar eventos

```http
GET /admin/api/webhooks?limit=50
```

```json
{
  "data": [
    {
      "id": "66666666-6666-4666-8666-666666666666",
      "api_cliente_id": "11111111-1111-4111-8111-111111111111",
      "link_id": "44444444-4444-4444-8444-444444444444",
      "event_type": "realizado",
      "status": "entregue",
      "attempts": 1,
      "next_attempt_em": "2026-10-23T15:05:00.000Z",
      "last_error": null,
      "delivered_em": "2026-10-23T15:05:01.000Z",
      "criado_em": "2026-10-23T15:05:00.000Z"
    }
  ]
}
```

#### Reenviar evento

```http
POST /admin/api/webhooks/:id/replay
```

Sem corpo. O evento volta para `pendente` e será entregue no próximo ciclo.

### 8.6 Sweeps assinados manualmente

Usado apenas no modo `SIGNER_MODE=psbt`.

```http
POST /admin/api/sweeps/:id/submit
Content-Type: application/json
```

```json
{
  "raw_transaction": "0x..."
}
```

Resposta:

```json
{
  "data": {
    "id": "88888888-8888-4888-8888-888888888888",
    "txHash": "0x...",
    "status": "enviado"
  }
}
```

Erros: `400` para transação inválida, `404` para sweep inexistente e `409`
quando o sweep não está aguardando assinatura manual.

### 8.7 Auditoria, alertas e status

#### Auditoria

```http
GET /admin/api/audit?limit=50
```

```json
{
  "data": [
    {
      "id": "99999999-9999-4999-8999-999999999999",
      "ator": "admin",
      "acao": "link.criado",
      "entidade": "link",
      "entidade_id": "44444444-4444-4444-8444-444444444444",
      "detalhes": {
        "apiClienteId": "11111111-1111-4111-8111-111111111111",
        "externalId": "pedido-123"
      },
      "ip": "127.0.0.1",
      "criado_em": "2026-10-23T15:01:00.000Z"
    }
  ]
}
```

#### Alertas

```http
GET /admin/api/alerts
```

Resposta:

```json
{
  "data": [
    {
      "nivel": "critico",
      "codigo": "gas_sponsor_ausente",
      "titulo": "Gas sponsor nao configurado",
      "descricao": "Sem GAS_SPONSOR_PRIVATE_KEY nenhum valor recebido pode ser movido.",
      "detalhe": {
        "variavel": "GAS_SPONSOR_PRIVATE_KEY"
      }
    }
  ]
}
```

#### Status

```http
GET /admin/api/status
```

```json
{
  "data": {
    "clientes": 1,
    "perfis_ramp": 2,
    "links_recentes": 10,
    "webhooks_recentes": 3,
    "links_por_status": {
      "aguardando": 2,
      "pago": 7,
      "nao_realizado": 1
    },
    "webhooks_por_status": {
      "entregue": 3
    }
  }
}
```

---

## 9. Erros e limites

### 9.1 Formato de erro

Erros de validação do corpo:

```json
{
  "erro": "dados invalidos",
  "detalhes": [
    {
      "campo": "amount_cents",
      "mensagem": "Too small: expected number to be >0"
    }
  ]
}
```

Erros de domínio:

```json
{
  "erro": "link ja recebeu pagamento; nao pode ser revogado",
  "codigo": "link_ja_pago"
}
```

Erros de autenticação:

```json
{
  "erro": "assinatura invalida"
}
```

Erro interno:

```json
{
  "erro": "erro interno do servidor"
}
```

### 9.2 Códigos HTTP

| HTTP | Uso |
|---|---|
| `200` | sucesso; também idempotência com `reused: true` |
| `201` | recurso criado |
| `400` | corpo inválido, regra de negócio ou assinatura de sweep inválida |
| `401` | API key ausente/inválida, headers HMAC ausentes ou assinatura inválida |
| `403` | token admin inválido |
| `404` | link, cliente, perfil, página ou sweep não encontrado |
| `409` | nonce reutilizado, idempotência conflitante, link já pago ou transição inválida |
| `429` | rate limit ou muitas falhas de autenticação |
| `500` | erro interno |

### 9.3 Limites

| Limite | Valor |
|---|---|
| Corpo JSON | 64 KB |
| Rate limit global | 120 requisições/minuto |
| Falhas de autenticação | 20/minuto por IP |
| Janela de timestamp | 300 segundos |
| Nonce | 8 a 128 caracteres, uso único por cliente |
| `limit` de listagens | 1 a 200, padrão 50 |
| `amount_cents` | 1 a 100000000 |
| `external_id` | 1 a 200 caracteres |
| `Idempotency-Key` | 1 a 200 caracteres |

### 9.4 Segurança

- A API key identifica o cliente; o `request_secret` assina cada requisição.
- O `webhook_secret` valida os webhooks recebidos.
- A URL da Ramp não é retornada pela API do cliente; ela só aparece na página
  pública `/p/:token`.
- O `page_token` é um bearer secret. Não registre `page_url` em logs públicos.
- A carteira de destino precisa estar previamente cadastrada e pertencer ao
  cliente; o motor recusa sweep para endereço desconhecido.
- Em produção, use HTTPS, mantenha `TRUST_PROXY=false` sem proxy confiável e
  proteja o `ADMIN_TOKEN`.

---

## 10. Exemplo completo em Node

```js
import { createHash, createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.MOTOR_BASE_URL ?? 'http://localhost:4578';
const API_KEY = process.env.MOTOR_API_KEY;
const REQUEST_SECRET = process.env.MOTOR_REQUEST_SECRET;

async function signedRequest(method, path, payload, query = '') {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');

  const canonical = [
    method.toUpperCase(),
    path,
    String(timestamp),
    nonce,
    bodyHash,
  ].join('\n');

  const signature = createHmac('sha256', REQUEST_SECRET)
    .update(canonical, 'utf8')
    .digest('hex');

  const url = query ? `${BASE}${path}?${query}` : `${BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'x-timestamp': String(timestamp),
      'x-nonce': nonce,
      'x-signature': `v1=${signature}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body || undefined,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

const profiles = await signedRequest('GET', '/v1/ramp-profiles');
const wallets = await signedRequest('GET', '/v1/wallets');

const link = await signedRequest('POST', '/v1/links', {
  external_id: `pedido-${Date.now()}`,
  amount_cents: 10000,
  ramp_profile_id: profiles.data[0].id,
  wallet_id: wallets.data[0].id,
  final_url: 'https://loja.example/obrigado',
});

console.log(link.data.page_url);

// Query string entra na URL, mas NÃO entra na string canônica.
const links = await signedRequest('GET', '/v1/links', undefined, 'limit=10');
console.log(links.data.length);
```
