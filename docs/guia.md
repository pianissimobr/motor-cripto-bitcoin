# Como o repositório funciona

Este texto descreve o repositório inteiro: o que cada pasta faz, como um pagamento Bitcoin anda de ponta a ponta, onde cada regra mora no código e o que o serviço recusa fazer. O contrato HTTP, com corpos e códigos, está em [API.md](API.md). O mesmo conteúdo, no formato do livro, está em [web/docs/index.html](../web/docs/index.html).

Há dois motores neste repositório. Só `services/btc-payments` é o contrato
atual; o Polygon/Ramp é **legado** e serve apenas de referência histórica.

| Motor | Onde | Porta | Situação | O que faz |
| --- | --- | --- | --- | --- |
| Bitcoin + PIX | `services/btc-payments` | 4580 | **Atual** | Cobrança em sats (Lightning + on-chain), PIX, portal do lojista, checkout `/pay/:id`, conversão THORChain e payout USDC na Base |
| Polygon / Ramp | `legacy/src/`, `legacy/web/admin/` | 4578 | **Legado** | Motor anterior de stablecoin. Página `/p/:token`, perfil de on-ramp, carteira allowlisted por cliente. Não implementa `/v1/payment-intents` |

`legacy/PLANO.md`, `legacy/projetoo.md` e `legacy/ENDURECIMENTO.md` registram decisões daquele motor antigo. O banner no topo de cada um avisa isso. Não use esses arquivos para integrar a API atual.

---

## 1. Mapa das pastas

```
motor-cripto-bitcoin/
├── services/btc-payments/     o produto: API, worker, portal, schema, testes
│   ├── src/                   código TypeScript que sobe em produção
│   ├── public/                portal, login, signup e snippet checkout.js
│   ├── tests/                 unitários e integração (Postgres)
│   ├── migrations/            SQL do Drizzle
│   ├── docs/                  manual, PIX, checkout, runbook, on-chain, webhooks
│   ├── scripts/               seed de cliente, criar intent, init da carteira
│   └── docker-compose.yml     Postgres, LNbits e bitcoind locais
├── web/docs/                  livro HTML de integração e operação
├── docs/                      este guia e a referência de API
├── legacy/web/admin/          painel do motor Polygon (legado)
├── legacy/src/                motor Polygon (legado; não é a API 4580)
├── legacy/db/                 schema do motor Polygon (legado)
└── legacy/start.py            sobe o processo da porta 4578 (legado)
```

Dentro de `services/btc-payments/src/`:

| Pasta | Papel |
| --- | --- |
| `server.ts` | Sobe só a API. Tem o xpub, o cliente do LNbits e o Esplora. Não abre keystore |
| `worker.ts` | Processo separado. Cinco jobs. O sweep só entra se o signer existir |
| `http/` | Fastify: rotas, HMAC, Bearer do admin, limite de corpo e de taxa, erros |
| `services/` | Criar cobrança, observar a chain, varrer, entregar webhook, alertar |
| `db/` | Drizzle: tabelas e repositório. O `WHERE` do SQL e a máquina de estados andam juntos |
| `domain/` | Sats, BIP21, status, valor Lightning, erros. Sem I/O |
| `adapters/hd/` | Deriva endereço P2WPKH a partir do xpub. Sem chave privada |
| `adapters/lnbits/` | Cria invoice e relê o pagamento |
| `adapters/chain/` | Esplora: UTXO, tx, taxa, broadcast |
| `adapters/signer/` | Assina o sweep: local (keystore), remoto ou PSBT manual |
| `crypto/` | HMAC, cifra dos segredos da loja, redação de log |
| `config.ts` | Tudo que o ambiente precisa declarar. Falha no boot se faltar |

A API e o worker são dois processos de propósito. A API cria cobrança e responde HTTP. O worker é quem descobre que o dinheiro chegou, muda o status e avisa a loja. Se o worker estiver parado, a cobrança continua existindo, mas nada confirma sozinho.

---

## 2. O que o serviço Bitcoin promete

A loja manda um identificador de pedido (`external_id`) e um valor em satoshis. O serviço devolve, na mesma resposta:

- uma invoice Lightning, criada no LNbits;
- um endereço Bitcoin exclusivo, derivado do xpub no caminho `m/84'/0'/0'/0/{índice}`;
- a URI BIP21 que junta os dois (`bitcoin:<endereço>?amount=<btc>&lightning=<invoice>`);
- o SVG do QR dessa URI.

Quem paga pode usar Lightning ou a rede. O worker relê a fonte de cada trilho antes de marcar pago. O POST do LNbits não é prova. A lista de UTXO sumir também não é prova de reorg.

O valor on-chain confirmado é varrido para `COLD_WALLET_ADDRESS`, uma carteira fria global. Não há carteira fria por loja. O que a operação enxerga de mistura é a soma de `paid_amount_sats` por cliente e por trilho, em `GET /admin/api/status`.

O serviço também hospeda a **página pública de checkout** em `/pay/:id` e o
snippet `/checkout.js`. A loja pode mostrar o QR no próprio sistema ou abrir
essa página.

Além do Bitcoin, o serviço atende **PIX**: a cobrança é criada na Lunium e o
valor é liquidado em **USDC na Base** na carteira `usdc_settlement` que a loja
cadastra. O motor não guarda os dólares.

---

## 3. Os três de fora e os dois de dentro

De fora:

1. **A loja.** Chama `/v1/*` com API key e HMAC. Recebe webhooks assinados na URL que cadastrou.
2. **O LNbits.** Emite a invoice e é a fonte do pagamento Lightning. Uma wallet só.
3. **O Esplora.** Fonte dos UTXOs, do tx, da altura da ponta, da taxa e do broadcast.

De dentro:

1. **A API** (`npm run dev`, porta 4580). Autentica, cria a intent, devolve o QR, cancela, e atende o admin e o webhook de entrada do LNbits.
2. **O worker** (`npm run worker`). Concilia Lightning, expira, observa a chain, entrega webhook e varre.

O xprv não entra na API. Ele fica no keystore cifrado do worker (`SIGNER_MODE=local`) ou num signer remoto. `SIGNER_MODE=psbt` não assina: grava a PSBT para o operador.

---

## 4. Uma cobrança, do pedido até a carteira fria

O exemplo do livro é 10.000 sats. O prazo padrão da invoice é 600 segundos. A carência on-chain é 86.400 segundos (24 horas) depois de `expires_at`.

### 4.1 Criar

`POST /v1/payment-intents` com HMAC.

1. A API exige `external_id` (1 a 128) e `amount_sats` inteiro positivo, string ou número. `description` até 200 caracteres. `expires_in_seconds` entre 30 e 86.400. `metadata` é um objeto livre, guardado e não devolvido no webhook.
2. Se já existe cobrança daquele cliente com o mesmo `external_id` e o mesmo valor, e ela já saiu de `criando`, a resposta é **200** com a cobrança existente. Valor diferente é **409**. Status `criando` é **409** pedindo para tentar de novo, sem devolver uma cobrança sem invoice. `falha_criacao` também é **409**: aquele `external_id` morreu.
3. Se é nova, o Postgres incrementa `next_receive_index` e grava a intent em `criando` junto com o endereço. O índice não volta, mesmo se o passo seguinte falhar.
4. O LNbits cria a invoice. O webhook que o LNbits vai chamar é `{LNBITS_WEBHOOK_BASE_URL ou PUBLIC_BASE_URL}/webhooks/lnbits?token={LNBITS_WEBHOOK_TOKEN}`.
5. Se o LNbits falha, a intent vai para `falha_criacao`, o endereço fica `abandonada`, e a API responde **502**. Use outro `external_id`.
6. Se o LNbits responde, a intent vai para `pendente` e a API responde **201** com invoice, endereço, BIP21 e SVG.

### 4.2 Pagar por Lightning

O LNbits chama `POST /webhooks/lnbits?token=…`. O token é comparado em tempo constante. O corpo pode ser objeto ou um JSON em string (LNbits 1.6). Dali sai `payment_hash` ou, na falta, `checking_id`.

O motor então chama `GET /api/v1/payments/{payment_hash}` no LNbits. Só essa resposta, marcada como paga, pode liquidar.

O número que o LNbits manda ora é sats, ora é msat, no mesmo campo. A regra:

- se o número cru é exatamente o `amount_sats` da invoice, a unidade é sats;
- se só bate depois de dividir por 1000, a unidade é msat;
- se não vem valor, ou o valor não bate com a invoice, a cobrança **não** muda de status. O operador recebe um alerta e a auditoria grava `intent.lightning_amount_mismatch`. O motor não inventa o valor da invoice.

Abaixo da invoice não liquida. Acima, se não bater exatamente numa das duas leituras, também não liquida.

Se a intent ainda é `pendente` e o relógio já passou de `expires_at`, o status gravado é `pago_tardio`, não `pago`. O mesmo vale se ela já estava `expirado` ou `parcial`.

Se a intent já está `pago` ou `pago_tardio` por on-chain, o Lightning soma, `paid_rail` vira `both` e sai alerta de duplicidade. A segunda entrega do mesmo `payment_hash` não soma de novo.

Se a intent está `cancelado`, o status não muda. Auditoria e alerta. O sats fica no LNbits para devolução manual.

O job `lightning-reconcile` (padrão 15 s) faz a mesma leitura nas intents pendentes, para o caso de o webhook de entrada se perder.

### 4.3 Pagar on-chain

O job `onchain-watch` (padrão 15 s) lê `GET /address/:addr/utxo` no Esplora para cada intent observada.

A confirmação é `altura_da_ponta − altura_do_bloco + 1`. O padrão é 1 confirmação. A partir de `ONCHAIN_HIGH_VALUE_SATS` (1.000.000) o padrão sobe para `ONCHAIN_HIGH_VALUE_CONFIRMATIONS` (3).

Quando a soma das saídas já confirmadas cobre `amount_sats`:

- antes de `expires_at`, e a intent ainda é `pendente` ou `reorg`: `pago`, `paid_rail = onchain`;
- depois de `expires_at`, ou se já era `expirado` ou `parcial`: `pago_tardio`;
- se já era Lightning: `paid_rail = both`, soma o on-chain e alerta duplicidade.

Excesso vira `overpaid_sats`. Não há percentual de tolerância.

### 4.4 Vencer

O job `expiry` (padrão 10 s) olha intents `pendente` com `expires_at` no passado.

Mempool não segura o relógio. Só entra na conta o que já está `confirmado`.

- confirmado cobre o pedido: o watcher é quem marca pago ou pago tardio; o job de expiração não fura isso se o confirmado já cobre (o watcher fecha no ciclo dele);
- confirmado é maior que zero e menor que o pedido: `parcial`, evento `payment_intent.partial`;
- confirmado é zero, mesmo com tx só na mempool: `expirado`, evento `payment_intent.expired`.

A intent `expirado` ou `parcial` continua na lista do watcher até `grace_until`. Se o confirmado completar o pedido nessa janela, vira `pago_tardio`.

Em `grace_until`, mempool que nunca confirmou não conta. O status fica o que o confirmado justificou.

### 4.5 Reorg

Sumir de `/address/:addr/utxo` não é reorg.

O watcher, para cada saída que estava `mempool`, `confirmado` ou (nas 24 h depois de `paid_at`) `gasto`:

1. Se a saída voltou para a lista, mas perdeu a confirmação: reorg daquela saída.
2. Se sumiu, e algum sweep nosso tem esse outpoint nos inputs, e o tx desse sweep ainda existe no Esplora, e o tx de depósito também existe: a saída vira `gasto`. A intent não muda. Esse valor continua na soma “ainda é nosso”, porque foi para a carteira fria.
3. Se o tx de depósito responde 404, ou a saída confirmada voltou à mempool: reorg de verdade daquela saída.
4. Erro do Esplora que não é 404 sobe. Um blip não marca reorg.

A intent só vai para `reorg` se, depois de tirar o que reorgou, esta soma ficar abaixo de `amount_sats`:

- a parte Lightning já contabilizada (invoice com status `pago`);
- mais as saídas ainda confirmadas o bastante;
- mais o que o nosso sweep já gastou e cujo depósito ainda existe.

Pagamento que foi só Lightning não reverte por causa de poeira on-chain. Se era `both` e o Lightning sozinho ainda cobre, a intent continua paga, o trilho volta para `lightning` e o valor pago é reescrito para a parte Lightning. Não sai outro webhook de pago.

`pago` → `reorg` emite `payment_intent.reorged`. Se a rede devolver o depósito e a soma cobrir de novo, a intent volta a `pago` ou `pago_tardio` e emite outro evento de pago. A chave de dedupe inclui a `version` da intent, então o segundo pago não é engolido.

`updateOnchainPaymentStatus` não rebaixa uma saída `gasto`, exceto quando o próprio tx de depósito sumiu (`forceFromGasto`).

### 4.6 Fora do prazo e cancelado

`cancelado` e o que passou de `grace_until` (`expirado` ou `parcial`) saem da lista que pode marcar pago. Não saem da observação de recuperação.

Se aparecer UTXO novo nesse endereço, o watcher grava a saída, alerta `fundos_fora_do_prazo` e **não** reabre a intent como paga. O sweep inclui `cancelado` junto com `pago`, `pago_tardio`, `parcial` e `expirado`, então o sats confirmado o bastante vai para a carteira fria.

### 4.7 Varrer

O job `sweep` (padrão 30 s), se o signer subiu:

1. Lista saídas `confirmado` com confirmações suficientes, nas intents acima, sem sweep ativo no mesmo endereço.
2. Monta uma transação com RBF (`sequence` que permite substituir), uma saída para `COLD_WALLET_ADDRESS`.
3. Rejeita taxa inválida, poeira (546 sats) e taxa acima de `SWEEP_MAX_FEE_PCT` (padrão `0.1`, isto é 10%).
4. Assina. Antes do `broadcastTx`, decodifica o raw e exige: os mesmos inputs da PSBT, uma única saída para a carteira fria, taxa dentro do limite. Vale para signer local, remoto e para o raw que o remoto devolve. Se não bater, o sweep vai para `falhou` e nada é transmitido.
5. Marca as saídas como `gasto` e o sweep como `aguardando_confirmacao_rede`.
6. Se passar `SWEEP_RBF_AFTER_SECONDS` (600 s) sem confirmar, reenvia com taxa maior, até `SWEEP_MAX_ATTEMPTS` (3). Esgotado, `manual`.

`POST /admin/api/sweeps/:id/retry` só restaura as saídas e deixa o sweep `falhou` quando o tx **não existe** no Esplora. Tx confirmado: 409. Tx ainda na mempool: 409, com o pedido de esperar o RBF. Sem txid (falhou antes do broadcast): o retry segue.

---

## 5. Estados que a loja observa

```
criando      → pendente | falha_criacao
pendente     → pago | pago_tardio | parcial | expirado | cancelado
expirado     → pago_tardio
parcial      → pago_tardio
pago         → reorg
pago_tardio  → reorg
reorg        → pago | pago_tardio
cancelado    → (nada)
falha_criacao → (nada)
```

`pago` e `pago_tardio` são dinheiro recebido. A loja decide no caixa dela se o tardio ainda entrega o pedido. `parcial` não quita. `reorg` desfaz a conclusão anterior.

`paid_rail` é `lightning`, `onchain` ou `both`.

Eventos de webhook: `payment_intent.paid`, `payment_intent.paid_late`, `payment_intent.partial`, `payment_intent.expired`, `payment_intent.canceled`, `payment_intent.reorged`.

A chave interna é `intent:{id}:{sufixo}:{version}`. A mesma transição não duplica. Uma transição nova, com `version` maior, gera outra linha.

---

## 6. Tabelas

Tudo em Postgres, via Drizzle, em `services/btc-payments/src/db/schema.ts`.

| Tabela | O que guarda |
| --- | --- |
| `api_clients` | Nome, hash da API key, segredo de request cifrado, URL e segredo de webhook cifrados, status `ativo` ou `inativo` |
| `api_nonces` | Nonce usado por cliente, com expiração. Reuso é 401 |
| `hd_wallet_state` | Uma linha. `next_receive_index`, `gap_limit`, fingerprint do xpub |
| `hd_addresses` | Índice, endereço, path, intent, status `alocada`, `usada`, `abandonada` ou `sweepada` |
| `payment_intents` | A cobrança. Valor, prazos, status, trilho, valores pagos, invoice, `version` |
| `lightning_payments` | Invoice, hash, valor, status, JSON cru (unidade ou o motivo de não liquidar) |
| `onchain_payments` | Um UTXO: txid, vout, valor, confirmações, status `mempool`, `confirmado`, `reorg` ou `gasto` |
| `onchain_sweeps` | A transação de varredura, inputs, taxa, PSBT, raw, tentativas |
| `webhook_events` | Outbox. Payload, tentativas, `dedupe_key` único |
| `audit_events` | Quem fez o quê. Não sai no webhook da loja |

`BTC_GAP_LIMIT` é gravado nessa linha de estado. O índice é sequencial. Um restore varre `0..next_receive_index` a partir do banco. Isso não é gap limit de carteira externa: um pagamento num índice que o banco nunca alocou não é descoberto sozinho. Não há script `wallet:scan` nesta leva.

Sats são `bigint`. Nada de float no meio do caminho. O BIP21 escreve BTC com 8 casas (`10000` sats → `0.00010000`).

---

## 7. Os jobs

| Job | Intervalo padrão | O que faz se falhar um item |
| --- | --- | --- |
| `lightning-reconcile` | 15 s | Conta erro e segue. Não marca pago sem a leitura do LNbits |
| `expiry` | 10 s | Conta erro e segue |
| `onchain-watch` | 15 s | Conta erro daquela intent e segue. Erro de Esplora que não é 404 não vira reorg |
| `webhook-delivery` | 10 s | Backoff 60 s, 5 min, 30 min, 2 h, 6 h, 24 h. Para na tentativa `WEBHOOK_MAX_ATTEMPTS` (6). Também apaga nonces vencidos |
| `sweep` | 30 s | Ausente se o signer não subiu. Os outros jobs seguem |

Um job não reentra nele mesmo. Falha do ciclo inteiro gera alerta se `ALERT_WEBHOOK_URL` existir.

O lote padrão é `JOBS_BATCH_SIZE` (50).

---

## 8. Confiança

### Loja → API

Cabeçalhos: `Authorization: Bearer mk_btc_live_…`, `X-Timestamp` (Unix, janela de 300 s), `X-Nonce` (8 a 128 caracteres, único por cliente), `X-Signature: v1=<hex>`.

String canônica, com quebras de linha reais:

```
METHOD
PATH
TIMESTAMP
NONCE
SHA256(corpo cru)
```

`PATH` é o path sem query. O corpo assinado é o JSON exato enviado. GET assina corpo vazio.

A API key é guardada como SHA-256. O segredo de assinatura é cifrado com AES-256-GCM (`DATA_ENCRYPTION_KEY`) e a chave de cifra inclui o id do cliente.

### API → loja

`X-Webhook-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 de `{timestamp}.{corpo}` com o `webhook_secret` mostrado uma vez na criação do cliente. Também vão `X-Webhook-Event` e `X-Webhook-Delivery` (o id da linha do outbox).

A entrega usa `redirect: 'error'`. Um 302 não é seguido e não conta como entregue. Em produção a URL do webhook tem de ser HTTPS.

Resposta 2xx marca entregue. O resto entra na fila de novo.

### Admin

`Authorization: Bearer {ADMIN_TOKEN}`. Em produção o token precisa ter pelo menos 32 caracteres. Não há HMAC nas rotas `/admin/api/*`.

### LNbits → API

Só o token na query. O corpo é ignorado como prova. A prova é o GET no LNbits.

### Limite

120 pedidos por minuto por cliente da API (a chave é o cabeçalho `Authorization`). No webhook do LNbits, 120 por minuto por IP. `/health` não entra no limite. Corpo máximo: 64 KiB.

---

## 9. Ambiente que o boot exige

O arquivo de exemplo do serviço é `services/btc-payments/.env.example`. O `.env` da raiz do repositório é do motor antigo.

Obrigatórios para a API subir: `ADMIN_TOKEN`, `DATABASE_URL`, `DATA_ENCRYPTION_KEY`, `BTC_NETWORK`, `BTC_XPUB`, `LNBITS_URL`, `LNBITS_API_KEY`, `LNBITS_WEBHOOK_TOKEN`, `ESPLORA_URL`. Com `SWEEP_ENABLED=true`, `COLD_WALLET_ADDRESS` tem de ser um endereço da mesma rede.

Em produção, além disso: `ADMIN_TOKEN` longo; signer local exige `SIGNER_PASSPHRASE`; signer remoto exige URL `https://` e `SIGNER_REMOTE_TOKEN`.

`BTC_XPUB` é xpub de conta BIP84, depth 3 (`m/84'/0'/0'`). O fingerprint fica em `hd_wallet_state`. Se o xpub mudar, o boot recusa.

Redes: `bitcoin`, `testnet`, `signet`, `regtest`. O endereço frio é validado contra a rede escolhida.

---

## 10. Subir na máquina

```bash
cd services/btc-payments
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run wallet:init    # mostra o mnemonic uma vez; grave o BTC_XPUB no .env
npm run dev            # API em :4580
npm run worker         # outro terminal
```

`GET /health` responde sem checar dependência. `GET /ready` exige Postgres, xpub que deriva, carteira fria válida se o sweep está ligado, LNbits e Esplora.

Testes: `npm test` não precisa de banco. `npm run test:integration` precisa de `TEST_DATABASE_URL` apontando para um Postgres com as migrations. A suíte trunca as tabelas do serviço Bitcoin. Não aponte isso para o banco de produção.

---

## 11. O que este serviço não faz

- Não fala com Ramp/Transak. Isso é do motor Polygon legado (`legacy/src/`, porta 4578).
- Não guarda os dólares do lojista: o settlement em USDC cai na carteira `usdc_settlement` cadastrada por ele.
- A carteira fria BTC e a wallet Lightning são globais; o ledger separa `merchant:<id>:*` e o payout USDC é por loja.
- Não varre um índice que o banco nunca alocou.
- Não devolve sozinho um Lightning pago depois do cancelamento.
- Não segue redirect no webhook de saída.
- O painel em `legacy/web/admin/` fala com o motor da porta 4578 (legado), não com este serviço.
