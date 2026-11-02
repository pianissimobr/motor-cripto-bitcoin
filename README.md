# Motor Cripto

Pagamentos em **Bitcoin** (Lightning e on-chain) e **PIX**, com liquidação em
**USDC na Base** para a carteira que o lojista cadastra.

O produto é o serviço em [`services/btc-payments`](services/btc-payments): uma
API HTTP, um worker e um portal do lojista. Ele cria a cobrança, mostra o QR,
prova o pagamento na fonte (LNbits, Esplora ou Lunium) e avisa a loja por
webhook. O motor Polygon/Ramp que está em `legacy/` é **legado** e não faz
parte do contrato atual.

## O que ele faz

| Trilho | Entrada | Como prova | Liquidação |
| --- | --- | --- | --- |
| Lightning | invoice no LNbits (`lnbc...`) | `GET /api/v1/payments/{hash}` no LNbits | conversão THORChain → USDC na Base |
| On-chain BTC | endereço BIP84 derivado do xpub + Esplora | UTXOs/confirmações no Esplora; sweep opcional | conversão THORChain → USDC na Base |
| PIX | cobrança na Lunium (`qr_copypaste`) | webhook + consulta canônica na Lunium | treasury USDC → payout na Base |

- **Portal do lojista**: `/login`, `/signup`, `/portal`, carteiras, relatórios e assinaturas.
- **Checkout público**: `/pay/:id` e o snippet `/checkout.js`.
- **Settlement**: o dinheiro cai na carteira `usdc_settlement` (`0x...` na Base) que a loja cadastra. O motor **não guarda** os dólares.
- **API**: `/v1/*` com API key + HMAC; `/admin/api/*` com `ADMIN_TOKEN`.
- **Worker**: conciliação Lightning, expiração, on-chain, webhooks, sweep, conversão, payout, PIX, assinaturas e reconciliação.

## Arquitetura

```text
loja/API ──HMAC──► btc-payments (4580) ──► Postgres
                         │
                         ├──► LNbits ──► LND ──► rede Lightning
                         ├──► Esplora (on-chain BTC)
                         └──► Lunium (PIX)
                         │
worker ◄─────────────────┘
   ├── prova o pagamento na fonte
   ├── converte BTC → USDC (THORChain)
   ├── payout USDC na Base (PAYOUT_ENABLED)
   └── webhook assinado para a loja
```

## Começar (local)

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

- `http://localhost:4580/health`
- `http://localhost:4580/ready`
- `http://localhost:4580/portal`

Para o sweep, `npm run wallet:init` mostra o mnemonic uma vez e o `BTC_XPUB`.
O `xprv` fica só no keystore do worker.

## Produção

O deploy de produção está documentado em
[`services/btc-payments/docs/deployment.md`](services/btc-payments/docs/deployment.md)
e no [`docker-compose.prod.yml`](services/btc-payments/docker-compose.prod.yml):

```bash
cd services/btc-payments
cp .env.production.example .env.production
# edite DOMAIN, POSTGRES_*, ADMIN_TOKEN, DATA_ENCRYPTION_KEY, BTC_XPUB,
# COLD_WALLET_ADDRESS, LNBITS_*, ESPLORA_URL, CONVERSION_*, PAYOUT_* e SIGNER_*
docker compose --env-file .env.production \
  -f docker-compose.prod.yml up -d --build
```

O compose de produção usa Caddy para 80/443. Em host compartilhado que já tem
nginx nessas portas, mantenha o nginx como borda e faça proxy para a API em
`4580` (ver [runbook](services/btc-payments/docs/runbook.md)).

## Repositório

```text
motor-cripto-bitcoin/
├── services/btc-payments/   # o produto: API, worker, portal, migrations, docs
├── docs/                    # contrato, mapa, livro HTML, planejamento e referências
├── web/docs/                # livro HTML de integração e operação
└── legacy/                  # motor Polygon/Ramp arquivado (não é o contrato atual)
```

O motor **Polygon/Ramp** (`legacy/src/`, `legacy/db/`, `legacy/web/admin/`,
`legacy/start.py`, `legacy/docker-compose.yml`, `legacy/PLANO.md`,
`legacy/projetoo.md`, `legacy/ENDURECIMENTO.md`) é legado: não implementa
`/v1/payment-intents` nem o fluxo atual.

## Documentação

- [Serviço btc-payments](services/btc-payments/README.md) — subir, carteiras, API e worker.
- [Manual do lojista](services/btc-payments/docs/manual.md) — integrar e operar.
- [Contrato HTTP](docs/API.md) — corpos, códigos e autenticação.
- [Mapa do repositório](docs/guia.md) — como o dinheiro anda no código.
- [Deployment](services/btc-payments/docs/deployment.md) e [runbook](services/btc-payments/docs/runbook.md).
- [PIX → USDC](services/btc-payments/docs/pix.md), [checkout](services/btc-payments/docs/checkout.md) e [webhooks](services/btc-payments/docs/webhooks.md).
- Livro HTML: [docs/index.html](docs/index.html) e [web/docs/index.html](web/docs/index.html).

## Segurança

- A API não guarda seed nem `xprv`. O `xprv` do sweep fica no keystore do worker ou num signer remoto.
- Segredos da loja são cifrados com AES-256-GCM.
- Webhooks de entrada nunca são prova: o motor sempre confere na fonte (LNbits ou Lunium).
- `ADMIN_TOKEN`, `METRICS_TOKEN`, `DATA_ENCRYPTION_KEY` e chaves de payout ficam só no `.env`/secret manager.
