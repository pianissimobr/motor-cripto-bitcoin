# Motor Cripto

Cobranças em **Bitcoin** (Lightning e on-chain) e **PIX**, com o dinheiro
caindo **direto nas carteiras do lojista**. O motor não guarda, não varre e não
converte nada: ele cria a cobrança, mostra o QR, prova o pagamento na fonte e
avisa a loja por webhook.

O produto é o serviço em [`services/btc-payments`](services/btc-payments): uma
API HTTP e um worker. O motor Polygon/Ramp e o portal do lojista, ambos em
`legacy/`, são **legado** e não fazem parte do contrato atual.

## As três carteiras do lojista

Cada loja cadastra em `POST /v1/wallets` as carteiras dos trilhos que quer
aceitar:

| Trilho | Carteira do lojista | Como o motor prova o pagamento |
| --- | --- | --- |
| Lightning | wallet LNbits dele (URL + Invoice key) | consulta a invoice na própria wallet dele |
| On-chain BTC | xpub BIP84 dele: cada cobrança usa um endereço derivado | UTXOs e confirmações no Esplora |
| PIX | endereço USDC (0x) na Base | status canônico na Lunium + conferência on-chain |

- A cobrança Bitcoin oferece só os trilhos que a loja cadastrou. Sem carteira
  Lightning nem xpub, a resposta é `409 bitcoin_wallet_required`.
- O PIX exige o endereço USDC: a Lunium entrega o dólar digital direto nele.
  Sem ele, `409 settlement_wallet_required`.
- A Invoice key do LNbits é guardada cifrada (AES-256-GCM) e nunca volta nas
  respostas. Use a Invoice/read key, nunca a Admin key.

## O que mais tem

- **Portal do lojista** (aposentado em 2026-11-07, em [`legacy/portal/`](legacy/portal/)):
  o login e o dashboard saíram do serviço que roda. O cadastro do lojista é
  feito pela API.
- **Checkout público**: `/pay/:id` e o snippet `/checkout.js`, que funciona em
  qualquer domínio.
- **API**: `/v1/*` com API key + HMAC; `/admin/api/*` com `ADMIN_TOKEN`.
- **Worker**: confere Lightning, expira cobranças, observa a chain, concilia o
  PIX, gera ciclos de assinatura e entrega webhooks.

## Arquitetura

```text
loja/API ──HMAC──► btc-payments (4580) ──► Postgres
                         │
                         ├──► LNbits do lojista (invoice e prova Lightning)
                         ├──► Esplora (prova on-chain nos endereços do xpub do lojista)
                         └──► Lunium (PIX → USDC na carteira do lojista)
worker ── prova na fonte ── webhook assinado para a loja
```

## Começar (local)

```bash
cd services/btc-payments
python3 start.py          # escolhe Lightning/on-chain/PIX e cria/valida o .env
docker compose up -d
npm install
npm run migrate
npm run dev               # API em :4580
npm run worker            # outro terminal
```

`python3 start.py --up` já sobe o compose e aplica as migrations. Depois
cadastre as carteiras da loja pela API (`POST /v1/wallets`) — o portal do
lojista foi aposentado e está em `legacy/portal/`.

## Produção

```bash
cd services/btc-payments
cp .env.production.example .env.production
# edite DOMAIN, POSTGRES_*, ADMIN_TOKEN, DATA_ENCRYPTION_KEY, METRICS_TOKEN,
# LNBITS_WEBHOOK_TOKEN, ESPLORA_URL e, se usar PIX, LUNIUM_*
docker compose --env-file .env.production \
  -f docker-compose.prod.yml up -d --build
```

O compose de produção usa Caddy para 80/443. Detalhes em
[`deployment.md`](services/btc-payments/docs/deployment.md) e no
[runbook](services/btc-payments/docs/runbook.md).

## Repositório

```text
motor-cripto-bitcoin/
├── services/btc-payments/   # o produto: API, worker, migrations, docs
├── docs/                    # contrato, mapa, livro HTML, planejamento e referências
└── legacy/                  # motor Polygon/Ramp arquivado (não é o contrato atual)
```

## Documentação

- [Serviço btc-payments](services/btc-payments/README.md) — subir, carteiras, API e worker.
- [Manual do lojista](services/btc-payments/docs/manual.md) — integrar e operar.
- [PIX → USDC](services/btc-payments/docs/pix.md), [on-chain](services/btc-payments/docs/onchain.md), [checkout](services/btc-payments/docs/checkout.md) e [webhooks](services/btc-payments/docs/webhooks.md).
- [Deployment](services/btc-payments/docs/deployment.md) e [runbook](services/btc-payments/docs/runbook.md).
- `docs/API.md`, `docs/guia.md` e o livro `docs/index.html` descrevem versões
  anteriores (com sweep, carteira fria e conversão) e ficam como referência
  histórica.

## Segurança

- A plataforma não tem seed, xprv nem chave de carteira: não há fundos sob a
  guarda dela. O xpub do lojista só deriva endereços.
- Segredos da loja (request secret, webhook secret, Invoice key do LNbits) são
  cifrados com AES-256-GCM.
- Webhooks de entrada nunca são prova: o motor sempre confere na fonte.
- `ADMIN_TOKEN`, `METRICS_TOKEN` e `DATA_ENCRYPTION_KEY` ficam só no
  `.env`/secret manager. Perder a `DATA_ENCRYPTION_KEY` invalida as Invoice keys
  e os segredos gravados.
