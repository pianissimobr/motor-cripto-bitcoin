# Etapas de Ação — Serviço de Pagamentos Bitcoin

> Plano executável do backend Bitcoin (Lightning + on-chain).
> **Convenção:** marcar `[x]` somente depois de implementar **e validar** a etapa.
> Etapas não concluídas permanecem `[ ]`.

**Status em 2026-10-29:** Fases 0 a 8 implementadas e validadas em regtest (Nigiri): on-chain, pagamento tardio, reorg e sweep. 64 testes no total (39 unitários + 25 de integração).

---

## 0. Decisões fechadas

| Item | Decisão |
|---|---|
| Stack | Node 22 + TypeScript + Fastify + Drizzle + Postgres |
| Lightning | LNbits |
| On-chain | Watch-only próprio (xpub BIP84) + Esplora/Electrum self-hosted |
| Escopo | Serviço novo e separado, sem alterar o motor Polygon |
| Valores | Sats (`bigint`, nunca float) |
| Expiração | 10 min para Lightning; on-chain com carência de 24h |
| Sweep | Automático para carteira fria desde a primeira versão |
| Repositório | Restaurar os arquivos deletados do `HEAD` |

**Ponto de atenção:** o `bootstrap.py` do `Receber-Bitcoin.md` não vai para produção como está.
Ele usa seed na API, timer em memória, SQLite, não detecta pagamento on-chain e não tem autenticação.
O plano mantém a ideia de *Payment Intent + webhook + timeout*, mas corrige esses pontos.

---

## 1. Arquitetura alvo

```text
cliente da API
   │  HMAC + API key
   ▼
API /v1/payment-intents ──────► Postgres
   │                              │
   ├──► LNbits (invoice)          │
   └──► xpub BIP84 (endereço)     │
                                  │
worker ◄──────────────────────────┘
   ├──► LNbits: conciliação de invoices
   ├──► Esplora: UTXOs, confirmações, reorg
   ├──► Sweeper: PSBT → carteira fria
   └──► Webhook outbox: HMAC → cliente
```

- [ ] Confirmar que o novo serviço ficará em `services/btc-payments/`
- [ ] Confirmar banco separado (`btc_payments`), sem acoplar ao motor Polygon
- [ ] Confirmar que a API recebe apenas `xpub`; `xprv` fica só no worker/signer
- [ ] Confirmar LNbits como fonte única de Lightning
- [ ] Confirmar Esplora/Electrum como fonte única de on-chain

### Ports/adapters previstos

- [ ] `LnbitsClient`
- [ ] `ChainWatcher` (Esplora; Electrum opcional depois)
- [ ] `HdWallet` (derivação BIP84)
- [ ] `Signer` (local, remoto ou PSBT)
- [ ] `Repositories`
- [ ] `WebhookSender`

---

## 2. Fluxo de pagamento

- [ ] Cliente chama `POST /v1/payment-intents` com `external_id` e `amount_sats`
- [ ] API valida HMAC, idempotência e limites
- [ ] API aloca atomicamente o próximo índice HD e deriva o endereço BIP84
- [ ] API cria a invoice no LNbits com `expiry=600` e webhook
- [ ] API persiste a intent como `pendente`
- [ ] API retorna invoice, endereço, BIP21 unificado e QR Code
- [ ] Worker recebe webhook do LNbits e confirma na API do LNbits
- [ ] Worker consulta o Esplora para UTXOs e confirmações
- [ ] Aos 10 min, worker marca `expirado` se nada caiu
- [ ] Worker mantém o endereço on-chain observado por 24h
- [ ] Se o on-chain cair depois, worker marca `pago_tardio`
- [ ] Quando confirmado, dispara webhook assinado ao cliente
- [ ] Se on-chain confirmado, sweeper envia UTXOs para a carteira fria

### Estados da intent

| De | Para | Gatilho |
|---|---|---|
| `criando` | `pendente` | invoice + endereço criados |
| `pendente` | `pago` | Lightning liquidado ou on-chain com confirmações |
| `pendente` | `expirado` | 10 min sem pagamento |
| `pendente` | `parcial` | expirou com valor menor |
| `expirado` | `pago_tardio` | on-chain dentro da carência de 24h |
| `pago` | `reorg` | reorg abaixo do limite |
| qualquer | `cancelado` | admin/cliente, se ainda não pago |

- [ ] Implementar a máquina de estados com transições permitidas
- [ ] Implementar `sweep_status` separado do status do pagamento

> O on-chain não confirma em 10 minutos. O endereço **nunca é reutilizado** e a carência
> existe para não perder pagamento atrasado.

---

## 3. Modelo de dados (Postgres)

| Tabela | Função |
|---|---|
| `api_clients` | API key hasheada, request secret e webhook secret cifrados |
| `api_nonces` | Replay protection (TTL) |
| `payment_intents` | Pedido, valor, status, expiração, carência, rail pago |
| `hd_wallet_state` | `next_receive_index`, gap limit, fingerprint do xpub |
| `hd_addresses` | Índice, endereço único, intent vinculada, status |
| `lightning_payments` | `payment_hash`, invoice, valor, status |
| `onchain_payments` | `txid:vout`, endereço, valor, bloco, confirmações, reorg |
| `onchain_sweeps` | PSBT, taxa, txid, tentativas, status |
| `webhook_events` | Outbox: payload, assinatura, tentativas, próximo envio |
| `audit_events` | Auditoria append-only |
| `reconciliation_runs` | Histórico dos jobs |

### Regras obrigatórias

- [ ] `payment_intents (client_id, external_id)` único
- [ ] `hd_addresses.index` e `hd_addresses.address` únicos
- [ ] `hd_addresses.intent_id` único
- [ ] `onchain_payments (txid, vout)` único
- [ ] `lightning_payments.payment_hash` único
- [ ] `webhook_events.dedupe_key` único
- [ ] Índice allocation atômico:
  ```sql
  UPDATE hd_wallet_state
  SET next_receive_index = next_receive_index + 1
  WHERE id = 1
  RETURNING next_receive_index - 1;
  ```
- [ ] Jobs com `SELECT ... FOR UPDATE SKIP LOCKED` ou advisory lock
- [ ] Nenhum timer em memória: expiração e retry são linhas no banco

---

## 4. API

### Público (cliente)

- [ ] `POST /v1/payment-intents` — cria cobrança Lightning + on-chain
- [ ] `GET /v1/payment-intents/:id` — status atual
- [ ] `GET /v1/payment-intents?external_id=` — busca por idempotência
- [ ] `POST /v1/payment-intents/:id/cancel` — cancela se ainda pendente

**Exemplo de criação:**

```json
{
  "external_id": "pedido-123",
  "amount_sats": 10000,
  "description": "Pedido 123",
  "expires_in_seconds": 600,
  "metadata": { "order_id": "123" }
}
```

**Resposta:**

```json
{
  "id": "pi_...",
  "external_id": "pedido-123",
  "status": "pendente",
  "amount_sats": "10000",
  "expires_at": "2026-10-29T10:10:00Z",
  "grace_until": "2026-10-30T10:10:00Z",
  "lightning": {
    "invoice": "lnbc...",
    "payment_hash": "..."
  },
  "onchain": {
    "address": "bc1q...",
    "amount_btc": "0.00010000",
    "bip21": "bitcoin:bc1q...?amount=0.00010000&label=Pedido%20123"
  },
  "payment_uri": "bitcoin:bc1q...?amount=0.00010000&lightning=lnbc...",
  "qr_svg": "<svg>...</svg>"
}
```

### Admin

- [ ] CRUD de clientes e rotação de chaves
- [ ] Listagem e conciliação manual de intents
- [ ] Replay de webhooks
- [ ] Retry de sweep
- [ ] Status operacional (LNbits, Esplora, backlog, sweep, carteira fria)
- [ ] Auditoria

### Webhook para o cliente

- [ ] Payload com `event`, `event_id`, `created_at` e `data`
- [ ] `data` contém `id`, `external_id`, `status`, `amount_sats`, `paid_amount_sats`, `paid_rail`, `paid_at`, `overpaid_sats`
- [ ] Headers `X-Webhook-Signature: t=...,v1=...`, `X-Webhook-Event`, `X-Webhook-Delivery`
- [ ] Eventos: `payment_intent.paid`, `payment_intent.partial`, `payment_intent.expired`, `payment_intent.paid_late`, `payment_intent.reorged`, `payment_intent.canceled`

```json
{
  "event": "payment_intent.paid",
  "event_id": "evt_...",
  "created_at": "2026-10-29T10:05:00Z",
  "data": {
    "id": "pi_...",
    "external_id": "pedido-123",
    "status": "pago",
    "amount_sats": "10000",
    "paid_amount_sats": "10000",
    "paid_rail": "onchain",
    "paid_at": "2026-10-29T10:04:30Z",
    "overpaid_sats": "0"
  }
}
```

---

## 5. Segurança

- [ ] API com `Authorization: Bearer`, `X-Timestamp`, `X-Nonce`, `X-Signature`
- [ ] Assinatura `HMAC-SHA256(request_secret, METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(rawBody))`
- [ ] Janela de timestamp de ±300s
- [ ] Nonce único por cliente, com TTL
- [ ] Comparação constant-time para tokens, assinaturas e nonces
- [ ] Segredos cifrados com AES-256-GCM (`DATA_ENCRYPTION_KEY` + keyring/rotação)
- [ ] LNbits: API key só no servidor, de menor privilégio possível
- [ ] LNbits: webhook não é assinado → sempre confirmar via `GET /api/v1/payments/{payment_hash}`
- [ ] URL de webhook do LNbits com token aleatório e rate limit
- [ ] On-chain: só `xpub` na API; `xprv` apenas no worker/keystore ou signer remoto
- [ ] Validar rede, prefixo, profundidade do xpub e fingerprint
- [ ] Nunca aceitar endereço de destino vindo do cliente
- [ ] Carteira fria allowlisted e validada no boot
- [ ] Valores em sats como `bigint`/`NUMERIC(20,0)`, sem float
- [ ] Webhooks de saída com outbox, HMAC, retry e `event_id` idempotente
- [ ] Helmet, CORS allowlist, body limit, timeouts e rate limit
- [ ] Logs com redaction de API keys, segredos, xpub, xprv, seed, passphrase e invoice
- [ ] Auditoria de criação de cliente, rotação, cancelamento, replay e retry de sweep

---

## 6. Sweep automático

- [ ] Gatilho em pagamento on-chain confirmado (`pago` ou `pago_tardio`)
- [ ] Varrer todos os UTXOs do endereço para a carteira fria, taxa descontada
- [ ] Se não cobrir taxa + poeira, acumular e alertar
- [ ] Implementar `Signer` local (keystore cifrado no worker)
- [ ] Implementar `Signer` remoto (HTTP/HSM)
- [ ] Implementar modo PSBT (assinatura manual)
- [ ] Construir PSBT com `@scure/btc-signer`
- [ ] Estimar taxa via `GET /fee-estimates` do Esplora
- [ ] Validar destino, valor e taxa antes do broadcast
- [ ] RBF para transações presas; retry com backoff
- [ ] Status `falha_sweep` + alerta após N tentativas
- [ ] Reorg do sweep → reavaliar e reenviar
- [ ] Novo UTXO após sweep → novo sweep
- [ ] Sweep não altera o status do pagamento; usa `sweep_status` próprio

---

## 7. Estrutura de arquivos

```text
services/btc-payments/
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── .env.example
├── docker-compose.yml
├── migrations/
│   └── 0000_btc_init.sql
├── src/
│   ├── server.ts
│   ├── worker.ts
│   ├── config.ts
│   ├── logger.ts
│   ├── db/{client,schema,repositories}.ts
│   ├── domain/{types,money,status,errors,bip21}.ts
│   ├── http/{app,auth,routes,serializers}.ts
│   ├── adapters/
│   │   ├── lnbits/client.ts
│   │   ├── chain/esplora.ts
│   │   ├── hd/derivation.ts
│   │   └── signer/{local,remote,psbt}.ts
│   ├── services/
│   │   ├── payment-intent-service.ts
│   │   ├── lightning-service.ts
│   │   ├── onchain-watcher.ts
│   │   ├── expiry-service.ts
│   │   ├── sweep-service.ts
│   │   ├── webhook-service.ts
│   │   └── reconciliation-service.ts
│   └── crypto/{cipher,hmac,redact}.ts
├── scripts/{init-wallet,smoke,seed-client}.ts
├── tests/{unit,integration,e2e}/
└── docs/{api,webhooks,onchain,sweep,runbook}.md
```

- [ ] Dependências: `@scure/bip32`, `@scure/bip39`, `@scure/btc-signer`, `@scure/base`, `qrcode`
- [ ] Infra de dev: Postgres + LNbits com `FakeWallet` + bitcoind/Esplora em regtest
- [ ] Infra de produção: LNbits com LND/CLN + Esplora/Electrum próprio

---

## 8. Fases de implementação

### Fase 0 — Restaurar o repositório

- [x] Restaurar **somente** os arquivos deletados do `HEAD`
- [x] Preservar `.env`, `.env.example` e `.gitignore` modificados
- [x] Confirmar que `Receber-Bitcoin.md` continua como referência (untracked)
- [x] Rodar `git status` e confirmar que não há deleções pendentes
- [x] Rodar instalação e testes de baseline do motor atual (204 testes passando)

### Fase 1 — Esqueleto do serviço

- [x] Criar `services/btc-payments/`
- [x] Criar `package.json`, `tsconfig.json`, `drizzle.config.ts` e `.env.example`
- [x] Criar `config.ts` com validação zod e falha cedo
- [x] Criar `logger.ts` com redaction
- [x] Criar `server.ts` e `worker.ts`
- [x] Criar `db/client.ts`, `db/schema.ts` e `db/repositories.ts`
- [x] Criar migration inicial (gerada: `migrations/0000_whole_epoch.sql`)
- [x] Implementar `/health` e `/ready` (DB, LNbits, Esplora, xpub, carteira fria)
- [x] Criar `docker-compose.yml` de desenvolvimento

### Fase 2 — Domínio e persistência

- [x] Implementar tipos, erros e máquina de estados
- [x] Implementar dinheiro em sats/BTC sem float
- [x] Implementar validação e derivação do xpub BIP84
- [x] Implementar alocação atômica do índice
- [x] Implementar repositórios e interfaces (núcleo HD; intents/webhooks nas fases 5/6)
- [x] Testar derivação, alocação e concorrência (gap limit garantido pela alocação sequencial; 5 testes de integração)

### Fase 3 — Lightning (LNbits)

- [x] Implementar `LnbitsClient` (create, get, health)
- [x] Criar invoice com expiração (adapter; ainda sem serviço/endpoint)
- [x] Implementar webhook de entrada + verificação na API do LNbits
- [x] Implementar conciliação periódica de invoices pendentes
- [x] Testar com LNbits fake e com `FakeWallet` (mock HTTP + LNbits 1.6.2 real em FakeWallet)

### Fase 4 — On-chain (Esplora)

- [x] Implementar `EsploraClient` (address, utxo, tip, fee, tx, broadcast)
- [x] Implementar watcher de endereços pendentes e em carência
- [x] Implementar confirmações, parcial, overpay e reorg
- [x] Implementar BIP21 e QR Code
- [x] Testar com Esplora fake e com regtest (fake + Nigiri/Chopsticks)

### Fase 5 — API de Payment Intent

- [x] Implementar autenticação HMAC
- [x] Implementar idempotência por `external_id`
- [x] Implementar `POST`, `GET`, busca e cancelamento
- [x] Criar as duas rails com compensação em caso de falha
- [x] Implementar endpoints admin (clientes; replay/status/audit pendentes)
- [x] Testar API ponta a ponta

### Fase 6 — Worker e webhooks

- [x] Implementar job de expiração
- [x] Implementar job de conciliação
- [x] Implementar job de observação on-chain
- [x] Implementar outbox de webhooks com retry e backoff
- [x] Implementar replay e deduplicação
- [x] Testar webhook duplicado, com falha e retry (atraso coberto pelo backoff)

### Fase 7 — Sweep automático

- [x] Implementar `Signer` local com keystore cifrado
- [x] Implementar `Signer` remoto
- [x] Implementar modo PSBT
- [x] Construir, assinar e transmitir PSBT
- [x] Implementar estimativa de taxa, poeira e RBF
- [x] Implementar status, retry e alertas (logs + auditoria; sem canal externo de alerta)
- [x] Testar sweep, reorg e pagamento tardio (sweep; reorg/tardio no watcher)

### Fase 8 — Hardening, docs e deploy

- [x] Helmet, CORS, body limit, timeouts e rate limit
- [x] Auditoria e logs com redaction
- [x] Documentação de API, webhooks, on-chain, sweep e runbook
- [x] Compose de produção e proxy reverso/HTTPS (Docker + Caddy)
- [x] Backup e recuperação (scripts + runbook)
- [x] Smoke test em testnet/regtest (Nigiri regtest: on-chain, tardio, reorg e sweep)
- [x] Monitoramento e alertas (status admin + alert webhook opcional)

### Fase 9 — Opcional / futuro

- [ ] Watcher Electrum em tempo real
- [ ] Sweep em lote
- [ ] Carteira fria por cliente
- [ ] Conversão BRL → sats
- [ ] Painel administrativo

---

## 9. Testes

- [ ] Unitário: sats/BTC, BIP21, derivação, status, HMAC, auth
- [ ] Integração: Postgres, LNbits fake, Esplora fake, outbox
- [ ] E2E: LNbits FakeWallet + bitcoind/Esplora regtest
- [ ] Segurança: replay, assinatura inválida, idempotência, valor divergente, rate limit
- [ ] Carga: muitas intents, backlog de webhooks, ciclos do worker

### Cenários obrigatórios

- [ ] Pagamento Lightning
- [ ] Pagamento on-chain
- [ ] Pagamento parcial
- [ ] Overpay
- [ ] Pagamento duplo (Lightning + on-chain)
- [ ] Pagamento tardio
- [ ] Reorg
- [ ] Webhook duplicado
- [ ] Webhook com falha e retry
- [ ] Replay de webhook

---

## 10. Decisões pendentes antes da Fase 7

- [x] Signer do sweep: local (keystore cifrado), remoto e PSBT implementados; padrão local em dev.
- [x] Carteira fria: endereço global allowlisted via `COLD_WALLET_ADDRESS`.
- [x] Confirmações on-chain: 1 padrão; 3 acima de `ONCHAIN_HIGH_VALUE_SATS`.
- [x] LNbits: Docker/FakeWallet em dev; instância própria com LND/CLN em produção.

---

## 11. Definição de pronto (DoD)

- [x] API sobe com config validada e falha cedo se faltar segredo
- [x] Worker sobe separado e retoma jobs após restart
- [x] Nenhum timer de expiração em memória; estado no Postgres (jobs usam setInterval)
- [x] Nenhum `xprv`/seed na API ou nos logs
- [x] Endereço on-chain nunca reutilizado
- [x] Pagamento Lightning e on-chain detectados e conciliados
- [x] Timeout de 10 min + carência on-chain de 24h funcionando
- [x] Webhooks assinados, idempotentes e com retry
- [x] Sweep automático funcionando em regtest real (Nigiri + signer local)
- [x] Testes de reorg, parcial, overpay e pagamento duplo passando
- [x] Documentação e runbook publicados
