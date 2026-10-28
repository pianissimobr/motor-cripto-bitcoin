# Motor Cripto

Motor **API-only** de pagamentos on-chain. O cliente da API cria uma cobrança,
recebe uma pagina hospedada em `/p/<token>` e um webhook quando o pagamento
chega a um estado final. O valor recebido e varrido para uma carteira
allowlisted do proprio cliente.

Documentacao de quem integra e de quem opera: o livro em [web/docs/index.html](web/docs/index.html), servido em `/docs/` quando a API esta no ar. O indice de rotas e [web/docs/18-referencia.html](web/docs/18-referencia.html). O mapa do codigo continua em [docs/guia.md](docs/guia.md).

```
cliente da API
   POST /v1/links  ->  link + page_url
                          |
                          v
                 /p/<token>  (Ramp + QR + endereco)
                          |
                  monitor on-chain
                          |
             pago / nao_realizado
                    |             |
                 webhook       sweep para carteira
                               allowlisted do cliente
```

## O que mudou

- Nao existe mais portal/cadastro de cliente final, creditos ou carteira fria global.
- O destino do sweep e uma carteira **do cliente**, cadastrada no admin.
- A API autentica com API key **e** assinatura HMAC por requisicao.
- O papel `api` nao recebe signer, keystore nem chave de gas.
- A URL da Ramp nunca sai em resposta de API; ela so aparece na pagina publica.

## Requisitos

- Node.js >= 22
- Postgres 16
- Docker Compose (para o banco local)
- Um RPC de Polygon (e das demais chains que voce habilitar)
- Uma carteira de gas com POL

## Subida local

```bash
cp .env.example .env
# edite ADMIN_TOKEN, DATA_ENCRYPTION_KEY, HD_XPUB e RPC_URL_POLYGON
npm install
docker compose up -d db
npm run migrate
npm run seed
npm run dev
```

Abra `http://localhost:4578/admin/` e informe o `ADMIN_TOKEN`.

O worker roda separado:

```bash
npm run worker
```

Para a primeira configuracao assistida:

```bash
python3 start.py
```

## Variaveis essenciais

| Variavel | Uso |
|---|---|
| `DATABASE_URL` | Postgres |
| `ADMIN_TOKEN` | Bearer do admin e do worker |
| `DATA_ENCRYPTION_KEY` | AES-256-GCM para segredos e token da pagina |
| `HD_XPUB` | xpub **de conta** `m/44'/60'/0'` |
| `SIGNER_KEYSTORE_PATH` / `SIGNER_PASSPHRASE` | xprv cifrado usado so pelo worker |
| `GAS_SPONSOR_PRIVATE_KEY` | POL para patrocinar o sweep; so no worker |
| `PUBLIC_BASE_URL` | base de `page_url` |
| `LINK_TTL_MINUTES` | validade da pagina (padrao 60) |
| `SETTLEMENT_DAYS` | janela on-chain em dias corridos (padrao 1) |
| `WEBHOOK_TIMEOUT_MS` / `WEBHOOK_MAX_ATTEMPTS` | entrega de webhook |
| `CONFIRMATIONS_REQUIRED` | confirmacoes on-chain |
| `PAYMENT_TOLERANCE_PCT` | tolerancia de valor |

`LINK_TTL_HOURS` e `COLD_WALLET_ADDRESS` foram removidos.

## Autenticacao da API

Toda rota `/v1/*` exige:

```http
Authorization: Bearer mk_live_...
X-Timestamp: 1792700000
X-Nonce: um-valor-unico-com-8-a-128-chars
X-Signature: v1=<hex>
Content-Type: application/json
```

String canonica:

```
METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody)
```

Assinatura: `HMAC-SHA256(request_secret, canonica)`.

- `PATH` nao inclui query string.
- A janela de timestamp e de 300 segundos.
- Cada nonce so pode ser usado uma vez por cliente.
- O corpo assinado e o JSON exato enviado, sem reserializar.

Exemplo em Node:

```ts
import { createHash, createHmac } from 'node:crypto';

const body = JSON.stringify({ external_id: 'pedido-1', amount_cents: 10000 });
const timestamp = Math.floor(Date.now() / 1000);
const nonce = crypto.randomUUID();
const canonical = [
  'POST',
  '/v1/links',
  String(timestamp),
  nonce,
  createHash('sha256').update(body).digest('hex'),
].join('\n');
const signature = createHmac('sha256', requestSecret).update(canonical).digest('hex');
```

## API do cliente

### Criar link

`POST /v1/links`

```json
{
  "external_id": "pedido-1",
  "amount_cents": 10000,
  "ramp_profile_id": "uuid",
  "wallet_id": "uuid",
  "final_url": "https://loja.example/obrigado"
}
```

Header opcional: `Idempotency-Key`. Sem ele, usa-se `external_id`.

Resposta `201` (ou `200` com `reused: true`):

```json
{
  "data": {
    "id": "uuid",
    "external_id": "pedido-1",
    "status": "aguardando",
    "valor_fiat_centavos": 10000,
    "moeda_fiat": "BRL",
    "expected_base_units": "18000000",
    "endereco_deposito": "0x...",
    "wallet_address": "0x...",
    "expira_em": "...",
    "liquidacao_ate": "...",
    "page_url": "https://pay.example/p/..."
  },
  "reused": false
}
```

Mesma chave + payload diferente retorna `409 idempotencia_conflitante`.

### Outras rotas

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/v1/links` | links do cliente (`?limit=`) |
| GET | `/v1/links/:id` | detalhe do link |
| POST | `/v1/links/:id/revoke` | revoga link ainda nao pago |
| GET | `/v1/ramp-profiles` | perfis Ramp ativos |
| GET | `/v1/wallets` | carteiras allowlisted do cliente |

O cliente precisa usar o `wallet_id` de uma carteira sua, na mesma chain do
perfil Ramp.

## Pagina publica

- `GET /p/:token` — HTML com valor, status, QR e link da Ramp.
- `GET /p/:token/status` — JSON de status.

O token e um bearer secret: fica cifrado no banco e indexado apenas por
SHA-256. Nao ha login de cliente final.

## Webhooks

Eventos:

- `realizado` — link chegou a `pago`, `pago_sem_gas` ou `movido`.
- `nao_realizado` — link chegou a `nao_realizado`.

Headers:

```http
x-webhook-signature: t=<unix>,v1=<hex>
x-webhook-event: realizado
x-webhook-delivery: <uuid>
```

Assinatura: `HMAC-SHA256(webhook_secret, "<t>.<corpo>")`.

O corpo e o JSON exato persistido na outbox. Retentativas: 60s, 5min, 30min,
2h, 6h, 24h (maximo configuravel). O admin pode reenviar um evento.

## Status do link

```
aguardando -> pago | parcial | pago_sem_gas | expirado | nao_realizado
expirado   -> pago | parcial | pago_sem_gas | nao_realizado
parcial    -> pago | expirado | nao_realizado
pago       -> movido | nao_realizado (reorg)
nao_realizado (terminal)
```

Motivos de `nao_realizado`: `nao_pago`, `valor_parcial`,
`pagamento_apos_prazo`, `revogado`, `reorg`.

A pagina expira em `LINK_TTL_MINUTES`; a verificacao on-chain continua ate
`liquidacao_ate` (1 dia corrido por padrao, contado em horas). Pagamento que chega depois do prazo
nao vira `pago`: o link termina em `nao_realizado` com
`pagamento_apos_prazo`, e o valor e varrido para a carteira allowlisted.

## Admin

Interface: `/admin/` (Bearer `ADMIN_TOKEN`).

Rotas principais:

| Metodo | Rota |
|---|---|
| POST/GET | `/admin/api/clientes` |
| GET/PATCH | `/admin/api/clientes/:id` |
| POST | `/admin/api/clientes/:id/rotate-key` |
| POST | `/admin/api/clientes/:id/rotate-webhook-secret` |
| GET/POST | `/admin/api/clientes/:id/wallets` |
| GET/POST | `/admin/api/ramp-profiles` |
| PATCH | `/admin/api/ramp-profiles/:id` |
| GET | `/admin/api/links` e `/admin/api/links/:id` |
| POST | `/admin/api/links/:id/revoke` |
| GET | `/admin/api/webhooks` |
| POST | `/admin/api/webhooks/:id/replay` |
| POST | `/admin/api/sweeps/:id/submit` |
| GET | `/admin/api/audit`, `/admin/api/alerts`, `/admin/api/status` |

A criacao de cliente devolve **uma unica vez** `api_key`, `request_secret` e
`webhook_secret`. O banco guarda apenas o hash da API key e os segredos
cifrados.

## Scripts

| Script | Uso |
|---|---|
| `npm run dev` | API |
| `npm run worker` | monitor, liquidacao, webhooks e sweeper |
| `npm run migrate` | aplica migrations |
| `npm run seed` | perfis Ramp |
| `npm run wallet:init` | keystore HD |
| `npm run smoke` | checa schema, indices e API |
| `npm test` | testes unitarios |
| `npm run test:integration` | Postgres real + migrations |
| `npm run build` | build TypeScript |

## Seguranca

- A API key e comparada por hash; o request secret fica cifrado com AAD do id.
- Assinaturas sao comparadas em tempo constante.
- Nonces sao de uso unico; timestamps fora de 300s sao recusados.
- Nenhuma chave privada ou seed e necessaria para subir a API.
- O destino do sweep precisa estar allowlisted para o cliente e para a chain.
- `HD_XPUB` e segredo: expoe todos os enderecos derivados e o historico.
