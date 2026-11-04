# btc-payments

Motor de cobranças em **Bitcoin** (Lightning e on-chain) e **PIX** em que o
dinheiro cai **direto nas carteiras do lojista**. A plataforma não guarda,
não varre e não converte nada: cria a cobrança, mostra o QR, prova o
pagamento na fonte e avisa a loja por webhook.

## As carteiras do lojista

| Trilho | O lojista cadastra | O dinheiro cai em | Prova |
| --- | --- | --- | --- |
| Lightning | URL + **Invoice key** da wallet LNbits dele | wallet LNbits dele | `GET /api/v1/payments/{hash}` na wallet dele |
| On-chain | **xpub** BIP84 (`m/84'/0'/0'`) | endereço derivado do xpub dele, um por cobrança | UTXOs e confirmações no Esplora |
| PIX | endereço **USDC (0x) na Base** | carteira Base dele (a Lunium entrega) | status canônico da Lunium + tx na Base |

- A cobrança Bitcoin oferece só os trilhos cadastrados pela loja. Sem wallet
  LNbits nem xpub: `409 bitcoin_wallet_required`.
- O PIX exige o endereço USDC: `409 settlement_wallet_required` sem ele.
- Uma carteira ativa por tipo: cadastrar outra substitui a anterior. Invoices
  antigas continuam conferidas na wallet onde foram criadas.
- A Invoice key é conferida (o motor chama a wallet antes de gravar) e fica
  cifrada com AES-256-GCM. A Admin key é recusada.
- Gap limit 1000 (`BTC_GAP_LIMIT`): o lojista configura o mesmo na carteira
  dele. No limite, a cobrança sai sem on-chain. Detalhes em `docs/onchain.md`.
- Toda troca de carteira dispara o webhook `merchant.wallet_changed`, alerta o
  operador e fica na auditoria.

## Requisitos

- Node.js >= 22
- Docker + Docker Compose
- Esplora/Electrum self-hosted para o on-chain (em dev, Nigiri ou equivalente)
- Para testar Lightning em dev: o compose sobe um LNbits com FakeWallet, que
  faz o papel da wallet de um lojista

## Subida local

```bash
cd services/btc-payments
python3 start.py          # escolhe os trilhos e cria/valida o .env
docker compose up -d
npm install
npm run migrate
npm run dev               # API em :4580
npm run worker            # outro terminal
```

`python3 start.py --engines lightning,onchain,pix --up` faz tudo de uma vez.
Abra `http://localhost:4580/portal`, crie a conta e cadastre as carteiras.

### Trilhos

| Flag | Liga | Precisa |
| --- | --- | --- |
| `LIGHTNING_ENABLED=true` | invoices na wallet LNbits do lojista | `LNBITS_WEBHOOK_TOKEN` |
| `ONCHAIN_ENABLED=true` | endereços do xpub do lojista | `ESPLORA_URL` |
| `PIX_ENABLED=true` | cobrança PIX via Lunium | `LUNIUM_API_KEY`, `LUNIUM_WEBHOOK_SECRET` |

O checkout `/pay/:id` mostra só os trilhos Bitcoin daquela cobrança. O PIX
tem fluxo próprio (QR da Lunium).

### LNbits em dev

1. Abra `http://localhost:5001`, crie uma wallet (FakeWallet) e copie a
   **Invoice/read key**.
2. No portal, em Carteiras → Lightning, informe a URL (`http://localhost:5001`)
   e essa key.
3. Para o webhook do LNbits chegar à API, `LNBITS_WEBHOOK_BASE_URL` precisa ser
   alcançável por ele. Em dev com Docker, habilite IPs privados no admin do
   LNbits (`Security -> callback allow private IPs`):

```bash
docker compose exec lnbits sh -lc 'cd /app && uv run python -c "import sqlite3; c=sqlite3.connect(\"/data/database.sqlite3\"); c.execute(\"update system_settings set value=? where id=?\", (\"true\",\"lnbits_callback_allow_private_ips\")); c.commit()"'
docker compose restart lnbits
```

Em produção, `LNBITS_WEBHOOK_BASE_URL` é a URL pública HTTPS do motor: as
wallets LNbits dos lojistas chamam `POST /webhooks/lnbits?w=<wallet>&token=...` (token próprio de cada wallet). Se o
webhook não chegar, o job `lightning-reconcile` confere a invoice mesmo assim.

### Carteira Base de teste

```bash
npm run wallet:base:init
```

Gera uma carteira descartável para cadastrar como `usdc_settlement` e testar o
PIX. Não commite a chave.

## Produção (Docker + Caddy)

```bash
cp .env.production.example .env.production
# edite DOMAIN, POSTGRES_*, ADMIN_TOKEN, DATA_ENCRYPTION_KEY, METRICS_TOKEN,
# LNBITS_WEBHOOK_TOKEN, LNBITS_WEBHOOK_BASE_URL, ESPLORA_URL e LUNIUM_*
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

- O serviço `migrate` aplica as migrations antes de API e worker.
- O Caddy faz HTTPS para `DOMAIN` (80/443 abertas, DNS apontando para o host).
- Não há keystore, seed nem chave de carteira para guardar no servidor.
- Guarde a `DATA_ENCRYPTION_KEY`: sem ela as Invoice keys e os segredos das
  lojas gravados no banco não abrem.

### Onde ficam os segredos

O cofre é o `chaves-cripto.md` na máquina do operador (kombitech), com
permissão `0600`. A VPS guarda cópias no `.env.production` (`0600`) — o
arquivo é a fonte da verdade: quando algo muda lá, o cofre é refeito a
partir do estado real, não no verso.

O cofre guarda: a `api_key` da LuniumPay, a chave e o endereço da tesouraria
de gas, o `ADMIN_TOKEN`, a `DATA_ENCRYPTION_KEY` e a credencial do app
(`APP_API_KEY` + `APP_REQUEST_SECRET`).

### Tesouraria de gas (gas station)

A tesouraria paga o gas das saídas do cliente: quem tem stablecoin, mas não
tem nativo, não consegue pagar o Pix. O motor empresta o nativo e cobra
depois.

```bash
# conferir o saldo e o endereço da tesouraria
curl -s https://$DOMAIN/admin/api/status -H "Authorization: Bearer $ADMIN_TOKEN" \
  | grep -o 'gasStation[^}]*}'
```

A chave fica no cofre (`GAS_SPONSOR_PRIVATE_KEY`) e no `.env.production` da
VPS (`GAS_STATION_PRIVATE_KEY`). Para trocar a chave — ou conferir que a chave
que você tem é a da tesouraria — use o script, que **deriva o endereço a
partir da chave e aborta se não bater**:

```bash
KEY=0x... scripts/set-gas-station-key.sh 0xENDERECO_ESPERADO
```

Estado atual: tesouraria `0x4Cd01696Cd0165D6020AB7d8AE866Fdf2feD3855`
(Polygon), com o saldo que dá para miles de reposições, verificado em
produção — `POST /v1/user/gas/topup` devolveu `201` com receipt `status 0x1`.

## API

Toda rota `/v1/*` (exceto `/v1/portal/*`) exige API key + HMAC:

```http
Authorization: Bearer mk_btc_live_...
X-Timestamp: 1792700000
X-Nonce: um-valor-unico-com-8-a-128-chars
X-Signature: v1=<hex>
```

String canônica `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody)`, assinada com
`HMAC-SHA256(request_secret, canonica)`; janela de 300 s, nonce de uso único.

| Método | Rota | Função |
|---|---|---|
| `POST` | `/v1/payment-intents` | Cria cobrança (trilhos conforme as carteiras da loja) |
| `GET` | `/v1/payment-intents/:id` | Consulta status |
| `GET` | `/v1/payment-intents?external_id=` | Busca por idempotência |
| `POST` | `/v1/payment-intents/:id/cancel` | Cancela se pendente |
| `GET` | `/v1/wallets` | Lista carteiras da loja |
| `POST` | `/v1/wallets` | Cadastra `lightning_lnbits`, `btc_deposit` ou `usdc_settlement` |
| `GET` | `/v1/fx/rates` | Cotações BTC/BRL e BTC/USD (para cobrar em reais) |
| `POST` | `/v1/pix-charges` | Cria cobrança PIX (Lunium) |
| `GET` | `/v1/pix-charges/:id` | Consulta cobrança PIX |
| `GET` | `/v1/pix-charges?external_id=` | Busca PIX por idempotência |
| `POST` | `/webhooks/lnbits?w=&token=` | Webhook de entrada das wallets LNbits (token por wallet) |
| `POST` | `/webhooks/lunium` | Webhook de entrada da Lunium |
| `POST/GET` | `/admin/api/clients` | Cria/lista clientes (admin) |
| `GET` | `/admin/api/status` | Contagens e saúde (admin) |
| `GET` | `/admin/api/webhooks` | Lista outbox (admin) |
| `POST` | `/admin/api/webhooks/:id/replay` | Reenfileira webhook (admin) |
| `GET` | `/admin/api/pix-charges` | Lista PIX (admin) |
| `POST` | `/admin/api/pix-charges/:id/sync` | Força conciliação com a Lunium (admin) |
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | DB, Esplora (se on-chain) e Lunium (se PIX) |

Cadastro de carteira via API:

```json
{ "kind": "lightning_lnbits", "lnbits_url": "https://seu-lnbits.com", "invoice_key": "..." }
{ "kind": "btc_deposit", "xpub": "xpub..." }
{ "kind": "usdc_settlement", "address": "0x..." }
```

As rotas `/v1/balances`, `/v1/conversions` e `/v1/payouts` continuam só como
histórico de versões anteriores; não há conversão nem payout novos.

Rotas do portal (cookie de sessão + `X-CSRF-Token`): `/auth/*`,
`/v1/portal/merchants/...` (lojas, carteiras, webhook, checkout, relatórios e
assinaturas). Página pública: `/pay/:id` e `/pay/:id/status`.

## Webhook de saída

```http
X-Webhook-Signature: t=<unix>,v1=<hex>
X-Webhook-Event: payment_intent.paid
X-Webhook-Delivery: <event_id>
```

Assinatura: `HMAC-SHA256(webhook_secret, "${timestamp}.${body}")`.
Eventos: `payment_intent.paid`, `.paid_late`, `.partial`, `.expired`,
`.canceled`, `.reorged` e, no PIX, `pix_charge.created`, `.paid`, `.settled`,
`.expired`, `.refunded`, `.failed`.

## Worker

| Job | Padrão | Função |
|---|---|---|
| `lightning-reconcile` | 15 s | Confere na wallet LNbits do lojista as invoices pendentes |
| `expiry` | 10 s | Expira/parcializa cobranças vencidas |
| `onchain-watch` | 15 s | Lê UTXOs, confirmações e reorg no Esplora |
| `pix-reconcile` / `lunium-inbox` | 30 s | Concilia o PIX com a Lunium |
| `subscription-charge` | 60 s | Gera a cobrança de cada ciclo de assinatura |
| `webhook-delivery` | 10 s | Entrega o outbox com assinatura e retry |
| `reconciliation` | 24 h | Registra a conciliação diária |

## Testes

```bash
npm test                 # unitários
TEST_DATABASE_URL=postgres://btc:btc_dev_password@localhost:5434/btc_payments_test \
  npm run test:integration
```

## Segurança

- O servidor não tem seed, xprv nem chave de carteira. O xpub do lojista só
  deriva endereços; a Invoice key do LNbits só cria e lê invoices.
- Segredos são cifrados com AES-256-GCM; logs têm redaction de chaves e CPF.
- Webhooks de entrada (LNbits, Lunium) nunca são prova: o motor confere na fonte.
