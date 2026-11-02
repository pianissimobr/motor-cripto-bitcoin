# btc-payments

Serviço separado de pagamentos Bitcoin: **Lightning via LNbits** + **on-chain
watch-only** (xpub BIP84 + Esplora/Electrum). Não altera o motor Polygon.

> Status: Fases 0-8 implementadas e validadas em regtest (Nigiri): on-chain,
> pagamento tardio, reorg e sweep. Inclui API, worker, Lightning, outbox,
> deploy com Caddy, runbook, backup, alertas, **portal do lojista** (login,
> dashboard, carteiras, relatórios), **checkout público** `/pay/:id` e
> **assinaturas recorrentes**.

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

O portal do lojista fica em `http://localhost:4580/portal` (cadastro e login).

### Motores (trilhos)

Você escolhe o que instalar no `.env`:

| Flag | Liga/desliga |
| --- | --- |
| `LIGHTNING_ENABLED=true` | invoice Lightning via LNbits |
| `ONCHAIN_ENABLED=true` | endereço BIP84 + Esplora + sweep |
| `PIX_ENABLED=true` | cobrança PIX via Lunium |

Com um motor `false`, as variáveis dele podem ficar vazias. O checkout público
`/pay/:id` mostra **só os trilhos Bitcoin habilitados** (Lightning e/ou
on-chain). O PIX continua no fluxo próprio (QR da Lunium).

Para configurar de forma guiada:

```bash
python3 start.py                 # pergunta os motores e grava no .env
python3 start.py --engines lightning,onchain --up
```

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

### Carteira Base de teste

```bash
npm run wallet:base:init
```

Gera uma treasury quente e uma carteira de loja descartaveis para testar PIX e
payout USDC na Base. Nao commit as chaves.

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

- [Manual do lojista (integração no seu site)](docs/manual.md)
- [FAQ (exibido dentro do portal)](../public/app.html)
- [API](docs/api.md)
- [Checkout one-time + snippet](docs/checkout.md)
- [Webhooks](docs/webhooks.md)
- [PIX -> USDC](docs/pix.md)
- [On-chain e sweep](docs/onchain.md)
- [Deployment, endpoints e topologia](docs/deployment.md)
- [Runbook operacional](docs/runbook.md)
- [Observabilidade e reconciliacao](docs/observability.md)
- [Drills de falha](docs/failure-drills.md)
- [Diario de drills](docs/drills-log.md)

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
| `GET` | `/v1/balances` | Saldos do ledger da loja |
| `GET` | `/v1/conversions` | Lista conversoes da loja |
| `GET` | `/v1/conversions/:id` | Detalhe e pernas da conversao |
| `GET` | `/v1/payouts` | Lista payouts da loja |
| `GET` | `/v1/payouts/:id` | Detalhe do payout |
| `GET` | `/v1/wallets` | Lista carteiras da loja |
| `POST` | `/v1/wallets` | Cria carteira BTC ou USDC |
| `GET` | `/v1/fx/rates` | Cotacoes BTC/BRL e BTC/USD |
| `POST` | `/v1/pix-charges` | Cria cobranca PIX (Lunium) |
| `GET` | `/v1/pix-charges/:id` | Consulta cobranca PIX |
| `GET` | `/v1/pix-charges?external_id=` | Busca cobranca PIX por idempotencia |
| `POST` | `/webhooks/lunium` | Webhook de entrada da Lunium |
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

Rotas do portal (cookie de sessão, não HMAC):

| Metodo | Rota | Funcao |
|---|---|---|
| `POST` | `/auth/register` | Cadastro (cria conta + loja default) |
| `POST` | `/auth/login` | Login (define cookie de sessão) |
| `POST` | `/auth/verify-email` | Confirma o e-mail |
| `GET` | `/auth/me` | Dados do usuário + lojas |
| `GET` | `/v1/portal/merchants` | Lista lojas do usuário |
| `POST` | `/v1/portal/merchants` | Cria nova loja (revela credenciais 1x) |
| `GET/PATCH` | `/v1/portal/merchants/:id` | Detalhe/atualiza loja |
| `GET/POST/DELETE` | `/v1/portal/merchants/:id/wallets` | Carteiras da loja |
| `POST` | `/v1/portal/merchants/:id/api-key/rotate` | Rotaciona API key |
| `POST` | `/v1/portal/merchants/:id/checkout` | Cria checkout one-time |
| `GET` | `/v1/portal/merchants/:id/intents` | Lista checkouts |
| `GET` | `/v1/portal/merchants/:id/reports/*` | Relatórios (summary/by-rail/series) |
| `POST/GET` | `/v1/portal/merchants/:id/subscriptions` | Assinaturas recorrentes |
| `GET` | `/pay/:id` | Página pública de checkout |
| `GET` | `/pay/:id/status` | Status público em JSON |

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
npm test                 # testes unitarios (vitest)
TEST_DATABASE_URL=postgres://btc:btc_dev_password@localhost:5434/btc_payments_test \
  npm run test:integration # testes de integracao (requer banco de teste)
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
