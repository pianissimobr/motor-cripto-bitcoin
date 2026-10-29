# btc-payments

Serviço separado de pagamentos Bitcoin: **Lightning via LNbits** + **on-chain
watch-only** (xpub BIP84 + Esplora/Electrum). Não altera o motor Polygon.

> Status: Fases 0-8 implementadas e validadas em regtest (Nigiri): on-chain,
> pagamento tardio, reorg e sweep. Inclui API, worker, Lightning, outbox,
> deploy com Caddy, runbook, backup e alertas.

## Requisitos

- Node.js >= 22
- Docker + Docker Compose
- Uma instância LNbits (em dev, o compose sobe com FakeWallet)
- Um Esplora/Electrum self-hosted (em dev, Nigiri ou equivalente)

## Subida local

```bash
cd services/btc-payments
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run dev
```

Em outro terminal:

```bash
npm run worker
```

Abra `http://localhost:4580/health` e `http://localhost:4580/ready`.

### Carteira e sweep

Para ativar o sweep automatico, gere a carteira BIP84 e o keystore cifrado:

```bash
npm run wallet:init
```

O script mostra o **mnemonic uma unica vez** e o `BTC_XPUB`. Guarde o mnemonic
offline, copie o `BTC_XPUB` para o `.env` e reinicie API/worker. O `xprv` fica
somente no keystore (`SIGNER_KEYSTORE_PATH`, modo 0600). O worker valida que o
keystore corresponde ao `BTC_XPUB`; se nao corresponder, o job de sweep nao
inicia.

O sweep:

- agrupa UTXOs confirmados por endereco;
- estima taxa pelo Esplora (`SWEEP_FEE_TARGET_BLOCKS`, `SWEEP_FEE_MULTIPLIER`);
- respeita `SWEEP_MIN_SATS`/poeira e `SWEEP_MAX_FEE_PCT`;
- assina no worker (`local`/`remote`) ou gera PSBT para assinatura manual (`psbt`);
- transmite, marca os UTXOs como `gasto` e monitora confirmacoes;
- faz RBF depois de `SWEEP_RBF_AFTER_SECONDS`, ate `SWEEP_MAX_ATTEMPTS`;
- se a taxa/poeira tornar o sweep inviavel, cria um sweep `manual` para revisao;
- `POST /admin/api/sweeps/:id/retry` restaura os UTXOs marcados como `gasto` e
  libera uma nova tentativa.

Sem keystore valido, o worker continua rodando os outros jobs e apenas desabilita
o sweep.

### LNbits

1. Abra `http://localhost:5001` e conclua o primeiro acesso.
2. Crie uma wallet (FakeWallet em dev) e copie a **Invoice/read key**.
3. Coloque a key em `LNBITS_API_KEY` no `.env`.
4. Para o webhook chegar em `host.docker.internal`, habilite IPs privados no
   admin (`Security -> callback allow private IPs`). Em dev, o valor também
   pode ser ajustado no SQLite:

```bash
docker compose exec lnbits sh -lc 'cd /app && uv run python -c "import sqlite3; c=sqlite3.connect(\"/data/database.sqlite3\"); c.execute(\"update system_settings set value=? where id=?\", (\"true\",\"lnbits_callback_allow_private_ips\")); c.commit()"'
docker compose restart lnbits
```

Em produção, mantenha isso desabilitado e use uma URL pública/HTTPS.

### Esplora

O compose sobe apenas `bitcoind` em regtest. Para on-chain, suba um
Esplora/Electrum apontando para esse `bitcoind` e ajuste `ESPLORA_URL`.
Sugestão para desenvolvimento: Nigiri (`nigiri start`) ou um Esplora próprio.

## Producao (Docker + Caddy)

```bash
cp .env.production.example .env.production
# edite DOMAIN, POSTGRES_*, ADMIN_TOKEN, DATA_ENCRYPTION_KEY, BTC_XPUB,
# COLD_WALLET_ADDRESS, LNBITS_*, ESPLORA_URL e SIGNER_*
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

- O servico `migrate` aplica as migrations antes de API/worker.
- O Caddy faz HTTPS automatico para `DOMAIN` (portas 80/443 abertas e DNS
  apontando para o host).
- O worker monta `./data:/app/data:ro` para ler o keystore; ajuste o dono para
  UID 1000 e mantenha o arquivo em `0600`.
- Em producao, prefira `SIGNER_MODE=remote`; use `local` apenas com o keystore
  no worker.
- Alertas opcionais: `ALERT_WEBHOOK_URL` recebe falhas de job, sweep manual,
  pagamento duplicado e reorg.

## Documentacao

- [API](docs/api.md)
- [Webhooks](docs/webhooks.md)
- [On-chain e sweep](docs/onchain.md)
- [Runbook operacional](docs/runbook.md)

## Criar cliente da API

```bash
npm run client:create -- --name "Minha loja" --webhook-url "http://localhost:9999/webhook"
```

Ou via admin:

```bash
curl -X POST http://localhost:4580/admin/api/clients \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Minha loja","webhook_url":"http://localhost:9999/webhook"}'
```

A resposta traz `apiKey`, `requestSecret` e `webhookSecret` **uma unica vez**.
Guarde os tres. Para testar localmente, coloque `CLIENT_API_KEY` e
`CLIENT_REQUEST_SECRET` no `.env`.

## Criar cobranca

```bash
npm run intent:create
# opcional: EXTERNAL_ID=pedido-1 AMOUNT_SATS=10000 DESCRIPTION="Pedido 1"
```

A resposta inclui:

- `lightning.invoice` e `lightning.payment_hash`
- `onchain.address`, `onchain.bip21` e `onchain.amount_btc`
- `payment_uri` unificado (BIP21 + `lightning=`)
- `qr_svg` pronto para renderizar

### Autenticacao HMAC

Toda rota `/v1/*` exige:

```http
Authorization: Bearer mk_btc_live_...
X-Timestamp: 1792700000
X-Nonce: um-valor-unico-com-8-a-128-chars
X-Signature: v1=<hex>
Content-Type: application/json
```

String canonica:

```text
METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody)
```

Assinatura: `HMAC-SHA256(request_secret, canonica)`. A janela de timestamp e
de 300s e cada nonce so pode ser usado uma vez.

## API

| Metodo | Rota | Funcao |
|---|---|---|
| `POST` | `/v1/payment-intents` | Cria cobranca Lightning + on-chain |
| `GET` | `/v1/payment-intents/:id` | Consulta status |
| `GET` | `/v1/payment-intents?external_id=` | Busca por idempotencia |
| `POST` | `/v1/payment-intents/:id/cancel` | Cancela se pendente |
| `POST` | `/webhooks/lnbits?token=` | Webhook de entrada do LNbits |
| `POST` | `/admin/api/clients` | Cria cliente (admin) |
| `GET` | `/admin/api/clients` | Lista clientes (admin) |
| `GET` | `/admin/api/sweeps` | Lista sweeps (admin) |
| `POST` | `/admin/api/sweeps/:id/retry` | Restaura UTXOs e tenta o sweep de novo |
| `GET` | `/admin/api/status` | Contagens e saude operacional (admin) |
| `GET` | `/admin/api/webhooks` | Lista outbox (admin) |
| `POST` | `/admin/api/webhooks/:id/replay` | Reenfileira webhook (admin) |
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | DB, xpub, carteira fria, LNbits e Esplora |

## Webhook de saida

O payload e assinado com o `webhookSecret` do cliente:

```http
X-Webhook-Signature: t=<unix>,v1=<hex>
X-Webhook-Event: payment_intent.paid
X-Webhook-Delivery: <event_id>
```

Assinatura: `HMAC-SHA256(webhook_secret, "${timestamp}.${body}")`.

Eventos: `payment_intent.paid`, `payment_intent.paid_late`,
`payment_intent.partial`, `payment_intent.expired`,
`payment_intent.canceled`, `payment_intent.reorged`.

O outbox grava o evento antes da primeira tentativa, tenta novamente com
backoff e usa `event_id`/`dedupe_key` para idempotencia.

## Worker

O worker roda em processo separado:

| Job | Padrao | Funcao |
|---|---|---|
| `lightning-reconcile` | 15s | Confirma invoices pagas quando o webhook se perde |
| `expiry` | 10s | Expira/parcializa intents vencidas |
| `onchain-watch` | 15s | Le UTXOs, confirmacoes e reorg no Esplora |
| `webhook-delivery` | 10s | Entrega o outbox com assinatura e retry |
| `sweep` | 30s | Cria/monitora sweeps e faz RBF |

> O sweep marca os UTXOs varridos como `gasto` em `onchain_payments`; assim o
> watcher nao interpreta a varredura como reorg.

## Testes

```bash
npm test                 # 39 testes unitarios
TEST_DATABASE_URL=postgres://btc:btc_dev_password@localhost:5434/btc_payments_test \
  npm run test:integration # 25 testes de integracao
```

A suite de integracao espera as migrations aplicadas no banco de teste.

## Seguranca

- `BTC_XPUB` e chave **publica** de conta BIP84 (`m/84'/0'/0'`). Nunca use
  `xprv`/seed na API.
- O `xprv` do sweep fica apenas no worker (keystore cifrado) ou em um signer
  remoto.
- `COLD_WALLET_ADDRESS` e validado contra a rede no boot.
- Segredos sao cifrados com AES-256-GCM.
- Logs tem redaction para API keys, xpub/xprv, invoices e PSBT.
- O webhook do LNbits nao e confiavel: o status e sempre confirmado em
  `GET /api/v1/payments/{payment_hash}`.
