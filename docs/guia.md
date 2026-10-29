# Motor Cripto: guia de primeiro acesso

Este texto é o mapa do serviço Bitcoin em `services/btc-payments`. Ele explica o que o sistema faz e em qual arquivo isso mora. Não é um manual linha a linha.

Quem integra a loja ou opera o admin, sem abrir estes arquivos, lê o livro em `web/docs/index.html`.

O motor antigo de stablecoin e Ramp está em `src/`. Ele não é este mapa. As decisões daquele motor ficaram em `PLANO.md`, `projetoo.md` e `ENDURECIMENTO.md`.

---

## 1. O que este serviço resolve

A loja manda um identificador de pedido e um valor em satoshis. O serviço devolve uma invoice Lightning e um endereço Bitcoin exclusivo, no mesmo QR. Um worker percebe o pagamento e avisa a loja por webhook. O valor on-chain é varrido para uma carteira fria única, configurada no operador.

Três processos de fora participam:

1. A loja, com API key e HMAC.
2. O LNbits, que emite a invoice e é a fonte do pagamento Lightning.
3. O Esplora, que é a fonte dos UTXOs, das confirmações e da taxa.

A API sobe sem chave privada. O xprv fica no worker (keystore) ou num signer remoto.

## 2. Uma cobrança, em uma frase por etapa

1. `POST /v1/payment-intents` valida HMAC, idempotência (`external_id` + valor) e o intervalo do prazo.
2. O Postgres incrementa o índice HD e a API deriva o endereço BIP84 a partir do xpub.
3. O LNbits cria a invoice. Se isso falha, a intent fica `falha_criacao` e o endereço é abandonado. O índice não volta.
4. A resposta traz invoice, endereço, URI BIP21 e o SVG do QR.
5. O worker relê o LNbits (webhook de entrada ou o job de conciliação) e o Esplora.
6. No vencimento, sem sats, a intent expira. Com sats a menos, fica parcial. Com a soma já no endereço mas sem confirmação, continua pendente.
7. On-chain dentro da carência de 24 horas vira `pago_tardio`.
8. UTXOs confirmados de intents pagas, tardias, parciais ou expiradas são varridos para `COLD_WALLET_ADDRESS`.

## 3. Onde cada regra mora

Tudo abaixo é relativo a `services/btc-payments/`.

| Quando você quiser entender... | Comece por |
| --- | --- |
| O livro para quem não abre código | `web/docs/index.html` (na raiz do repositório) |
| Subir API e worker | `README.md`, `src/server.ts`, `src/worker.ts` |
| O que o ambiente exige | `src/config.ts`, `.env.example` |
| Criar a cobrança | `src/services/payment-intent-service.ts` |
| Derivar endereço sem chave privada | `src/adapters/hd/derivation.ts` |
| Reservar o índice | `src/db/repositories.ts` (`createIntentWithAddress`) |
| Falar com o LNbits | `src/adapters/lnbits/client.ts` |
| Ler UTXO e reorg | `src/services/onchain-watcher.ts` |
| Varrer | `src/services/sweep-service.ts` |
| Assinar | `src/adapters/signer/` |
| HMAC e webhook de saída | `src/crypto/hmac.ts`, `src/http/auth.ts`, `src/services/webhook-delivery-service.ts` |
| Sats sem float | `src/domain/money.ts` |
| Tabelas | `src/db/schema.ts` |
| Rotas HTTP | `src/http/api-routes.ts` |
| Operar em produção | `docs/runbook.md` |

## 4. Os dois processos

`src/server.ts` sobe a API. Ele tem xpub, segredos cifrados e o cliente do LNbits para criar invoice. Não abre o keystore.

`src/worker.ts` sobe cinco jobs: conciliação Lightning, expiração, observação on-chain, entrega de webhook e sweep. O sweep só nasce se o signer local, remoto ou PSBT corresponder ao xpub. Os outros jobs seguem mesmo sem keystore.

## 5. O que não procurar aqui

Não há página `/p/:token`, perfil Ramp, cotação em centavos, gas sponsor em POL nem carteira allowlisted por cliente. Se um arquivo em `src/` na raiz do repositório falar disso, ele pertence ao motor anterior.
