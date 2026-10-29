# Motor Cripto

Motor de pagamentos **Bitcoin**: Lightning via LNbits e on-chain watch-only
(xpub BIP84 + Esplora). A loja cria uma cobrança, mostra o QR e recebe um
webhook quando o pagamento chega a um estado final. O valor on-chain é varrido
para a carteira fria do operador.

O livro de quem integra e de quem opera está em
[web/docs/index.html](web/docs/index.html). O mapa do repositório, com o
caminho de um pagamento, está em [docs/guia.md](docs/guia.md). O contrato
HTTP, com corpos e códigos, está em [docs/API.md](docs/API.md).

```
cliente da API
   POST /v1/payment-intents  ->  invoice + endereço + QR
                                      |
                         Lightning (LNbits) ou on-chain (Esplora)
                                      |
                    pago / pago_tardio / expirado / parcial
                                      |
                                   webhook
                                      |
                    sweep on-chain para COLD_WALLET_ADDRESS
```

A API deste serviço escuta na porta **4580**. Ela não hospeda página de
checkout e não fala com a Ramp.

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

Para o sweep, `npm run wallet:init` mostra o mnemonic uma vez e o `BTC_XPUB`.
O xprv fica só no keystore. Detalhe de produção, backup e alertas:
[services/btc-payments/docs/runbook.md](services/btc-payments/docs/runbook.md).

## Contrato em uma página

| Quem | Auth | O que faz |
|---|---|---|
| Loja | API key + HMAC | `POST /v1/payment-intents` |
| Operador | `ADMIN_TOKEN` | cria cliente, vê sweep e reenvia webhook |
| LNbits | token na query | avisa invoice paga; o motor confirma na API do LNbits |

Valor em satoshis, string inteira. Prazo padrão da invoice: 10 minutos.
Carência on-chain: 24 horas. Confirmações: 1, ou 3 a partir de 1.000.000 sats.

## Motor anterior

`src/`, a porta 4578 e os arquivos `PLANO.md`, `projetoo.md` e
`ENDURECIMENTO.md` descrevem o motor antigo de stablecoin na Polygon, com
página Ramp. Esse código continua no repositório. Não é o contrato do livro
nem o da API em `services/btc-payments`.
