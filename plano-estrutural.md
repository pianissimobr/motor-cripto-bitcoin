# Plano estrutural — Bitcoin -> USDC na Base

Status: em execução.

Este documento fecha o desenho técnico do novo fluxo sobre `services/btc-payments`.
As fases abaixo são marcadas com `[x]` conforme forem implementadas e validadas.

## Decisões fechadas

| Tema | Decisão |
|---|---|
| Custódia | Plataforma custodia BTC e USDC apenas durante o fluxo; o USDC final vai para a carteira da loja |
| Chain principal | Base |
| Stablecoin | USDC nativo |
| Conversão | THORChain BTC -> USDC Base |
| Polygon | Opcional no futuro via CCTP |
| Carteira por loja | xpub de depósito BTC por loja + carteira USDC externa allowlisted por loja |
| Cold wallet BTC por loja | Fora do MVP |
| Payout | Imediato após conversão, com agrupamento opcional por configuração |
| Limite automático | Até R$10k ou equivalente em USD por payout; acima, aprovação manual |
| Exposição sem KYC | R$10k por loja/dia, configurável |
| Câmbio | Cotação travada no checkout; spread embutido |
| Risco pós-pagamento | Plataforma/loja; conversão imediata para minimizar |
| THORChain | Endpoints públicos com fallback |
| Exposição | API-first; portal interno agora, portal do lojista depois |

## 1. Fluxo alvo

```text
BTC / Lightning
   -> btc-payments
   -> treasury BTC da plataforma
   -> THORChain
   -> USDC nativo na Base
   -> carteira USDC da loja
```

1. A loja cadastra xpub de depósito BTC e carteira USDC na Base allowlisted.
2. A loja cria a intent com valor em BRL/USD ou sats.
3. A API busca taxa, aplica spread, trava a cotação e grava `fx_quote`.
4. O cliente paga via Lightning ou on-chain.
5. O worker confirma na fonte oficial (LNbits ou Esplora).
6. O BTC on-chain é varrido para a treasury BTC.
7. O saldo Lightning é sacado do LNbits para a treasury BTC.
8. O job de conversão consulta a quote da THORChain, envia BTC ao inbound vault e recebe USDC na Base.
9. O ledger registra BTC recebido, taxas, spread e USDC líquido da loja.
10. O payout envia USDC à carteira da loja: automático até o limite; acima, aprovação.
11. Webhooks informam paid, converted, payout sent/confirmed/failed.

## 2. Módulos

```text
src/
  merchants/
    merchant-service.ts
    wallet-service.ts
  fx/
    fx-service.ts
    rate-provider.ts
  conversion/
    conversion-service.ts
    conversion-state.ts
  treasury/
    treasury-service.ts
    lightning-treasury.ts
    btc-treasury.ts
  ledger/
    ledger.ts
    ledger-repository.ts
  payouts/
    payout-service.ts
    payout-limits.ts
  adapters/
    fx/
      coinbase.ts
      awesomeapi.ts
      fallback.ts
    conversion/
      thorchain.ts
      mock.ts
      cctp.ts          # futuro
    payout/
      base-usdc.ts
```

Dependência nova para EVM: `viem`. Bitcoin continua com `@scure/btc-signer`.

## 3. Modelo de dados

Migrações novas a partir de `0003_`.

### `api_clients` — campos novos

```text
base_currency              BRL | USD
settlement_asset           USDC
settlement_chain           base
spread_bps                 integer
auto_payout_limit_brl      bigint
auto_payout_limit_usd      bigint
unverified_daily_limit_brl bigint
unverified_total_limit_brl bigint
verification_status        unverified | pending | verified
payout_batch_seconds       integer
```

### `merchant_wallets`

```text
id
merchant_id
kind              btc_deposit | usdc_settlement
chain             bitcoin | base
network           mainnet | testnet
address
xpub              nullable para USDC
derivation_prefix nullable
status            ativo | inativo
created_at
```

### `merchant_wallet_state`

```text
wallet_id
next_receive_index
gap_limit
xpub_fingerprint
```

### `hd_addresses`

Adicionar `merchant_wallet_id`.

### `payment_intents` — campos novos

```text
merchant_wallet_id
currency
amount_fiat
fx_quote_id
settlement_status
conversion_order_id
payout_id
```

### `fx_rates`

```text
id
base_currency
quote_currency
rate
source
observed_at
```

### `fx_quotes`

```text
id
merchant_id
base_currency
quote_asset
amount_in
amount_out
rate
spread_bps
source
expires_at
status
created_at
```

### `conversion_orders`

```text
id
merchant_id
intent_id
fx_quote_id
source_asset
source_amount_sats
target_asset
target_chain
target_amount_minor
provider
provider_order_id
status
fee_sats
fee_minor
txids jsonb
error
attempts
created_at
updated_at
```

### `conversion_legs`

```text
id
conversion_id
leg           thorchain | cctp_burn | cctp_mint | payout
provider
status
txid
provider_ref
amount_in
amount_out
fee_minor
created_at
```

### `payouts`

```text
id
merchant_id
conversion_id
wallet_id
asset
chain
amount_minor
status
txid
fee_minor
idempotency_key
approved_by
created_at
sent_at
confirmed_at
```

### `ledger_accounts`

```text
id
merchant_id nullable
code
asset
kind
```

### `ledger_transactions`

```text
id
kind
reference_type
reference_id
created_at
```

### `ledger_entries`

```text
id
transaction_id
account_id
asset
debit_minor
credit_minor
created_at
```

### `treasury_wallets`

```text
id
kind        btc_hot | btc_cold | usdc_hot | gas_base
chain
address
xpub nullable
status
```

### `provider_events`

Tabela de idempotência e auditoria das respostas de THORChain/CCTP.

## 4. Contas do ledger

Por loja:

```text
merchant:{id}:btc_receivable
merchant:{id}:usdc_available
merchant:{id}:fees
merchant:{id}:payout_in_transit
```

Plataforma:

```text
platform:spread
platform:network_fees
treasury:btc
treasury:usdc
conversion:clearing
```

Regras:

- toda transação tem débito e crédito iguais;
- nada de update em saldo; saldo é derivado dos lançamentos;
- correção só por lançamento reverso;
- sats, centavos e USDC em `bigint`;
- taxa em ponto fixo, nunca `float`.

## 5. API

### Criar intent

```http
POST /v1/payment-intents
```

```json
{
  "external_id": "pedido-123",
  "amount": "100.00",
  "currency": "BRL",
  "settlement": {
    "asset": "USDC",
    "chain": "base",
    "wallet_id": "uuid"
  }
}
```

### Resposta

```json
{
  "id": "uuid",
  "amount_sats": "10000",
  "fx_quote": {
    "id": "uuid",
    "rate": "0.00000100",
    "spread_bps": 100,
    "expires_at": "2026-10-30T12:00:00.000Z"
  },
  "settlement": {
    "asset": "USDC",
    "chain": "base",
    "wallet_id": "uuid",
    "status": "nao_iniciado"
  }
}
```

### Endpoints novos

```text
GET  /v1/balances
GET  /v1/conversions
GET  /v1/conversions/:id
GET  /v1/payouts
GET  /v1/payouts/:id
GET  /v1/wallets
POST /v1/wallets
GET  /v1/fx/rates
```

### Admin

```text
GET  /admin/api/merchants
GET  /admin/api/treasury
GET  /admin/api/conversions
POST /admin/api/conversions/:id/retry
GET  /admin/api/payouts
POST /admin/api/payouts/:id/approve
POST /admin/api/payouts/:id/retry
GET  /admin/api/reconciliation
```

Escopos:

```text
payments:write
payments:read
wallets:read
wallets:write
balances:read
conversions:read
payouts:read
```

## 6. Conversão com THORChain

Estados:

```text
criada
  -> cotando
  -> enviando_btc
  -> aguardando_swap
  -> recebendo_usdc
  -> convertida
  -> falhou
  -> reembolsada
  -> manual
```

Cuidados:

- usar o memo retornado pela quote; nunca montar manualmente;
- usar no mínimo 2 endpoints THORChain e comparar;
- se os endpoints divergirem, abortar e alertar;
- usar `limit` para proteger contra slippage;
- converter só depois de `CONVERSION_MIN_CONFIRMATIONS`;
- se o valor for abaixo do mínimo econômico, acumular;
- a conversão não pode derrubar o pagamento: `settlement_status` é separado.

## 7. Payout Base USDC

- USDC nativo na Base: `0x833589fCD6EDB6E08F4C7C32D4f71b54BDA02913`.
- Gas em ETH na Base; manter `gas_base` e monitorar.
- Usar `viem`.
- Assinatura via signer remoto com política: destino allowlisted, chain, valor máximo, limite diário, bloqueio de destino novo.
- Estados:

```text
pendente
  -> aprovado
  -> enviando
  -> confirmado
  -> retido
  -> falhou
```

Regras:

- `amount <= auto_payout_limit`: automático;
- `amount > auto_payout_limit`: aprovação;
- limite diário excedido: retido;
- carteira nova: 24h de carência;
- payout irreversível: allowlist e confirmação obrigatórias.

## 8. Câmbio

- `fx_rates`: BTC/BRL, BTC/USD, USD/BRL.
- `fx_quotes`: trava de checkout.
- `spread_bps` embutido no preço.
- Fonte primária + fallback; rejeitar taxa velha ou fora de faixa.
- Cliente paga sats fixos; spread é dele. Variação pós-pagamento fica com loja/plataforma; conversão imediata.

## 9. Infra própria e hardware

Vale auto-hospedar: Bitcoin Core, Esplora/electrs, LNbits, Postgres, API, worker, signer/HSM, monitoramento e backup.

Não vale no protótipo: THORChain full node, nó próprio da Base, nó próprio da Polygon.

| Componente | Protótipo | Produção pequena |
|---|---|---|
| Bitcoin Core + Esplora/electrs | 8 vCPU, 32 GB RAM, 2 TB NVMe, 1 Gbps | 16 vCPU, 64 GB RAM, 4 TB NVMe RAID1 |
| API + worker | 4 vCPU, 16 GB RAM, 200 GB NVMe | 2x 8 vCPU, 32 GB RAM, 500 GB NVMe |
| Postgres | 4 vCPU, 16 GB RAM, 200 GB NVMe | Gerenciado com HA + réplica |
| LNbits | 2 vCPU, 4 GB RAM, 100 GB NVMe | 4 vCPU, 8 GB RAM, HA |
| Signer/HSM | 2 vCPU, 4 GB RAM + HSM | HSM/remote signer dedicado, redundante |
| Base RPC | Gerenciado + fallback | Gerenciado + OP node opcional |
| THORChain | 2–3 endpoints públicos | Full node opcional (32+ cores, 128 GB+ RAM, 8 TB+ NVMe) |
| Monitoramento | 2 vCPU, 4 GB, 100 GB | Separado, HA |
| Backup | Offsite criptografado | 3-2-1 com teste de restore |

Recomendações: NVMe, rede privada WireGuard/Tailscale, sem porta pública para Postgres/RPC/signer, Caddy só 80/443, disco criptografado, UPS, SSH por chave, firewall, backup offsite, signer separado da API, HSM compatível com secp256k1, cold storage com multisig.

## 10. Segurança

- API nunca vê chave privada; só o signer assina.
- Signer com política: destino allowlisted, valor máximo, limite diário, chain permitida, auditoria.
- API keys com escopos, hash, rotação, nonce e HMAC.
- `ADMIN_TOKEN` só no servidor; admin atrás de VPN/Cloudflare Access/Tailscale.
- Portal do lojista futuro: OIDC/SSO, MFA, cookie HttpOnly, CSRF, RBAC, step-up.
- Sem KYC: beta fechado, R$10k por loja/dia, revisão manual acima, `verification_status` desde já.

## 11. Fases de implementação

### Fase 0 — Decisões e prova de conceito

- [x] Fechar Base como chain primária.
- [x] Escolher 2–3 endpoints THORChain e 2 RPCs Base (`docs/deployment.md`).
- [ ] Validar quote `BTC -> BASE.USDC` (ver `test-real.md`).
- [ ] Fazer um swap pequeno de ponta a ponta (ver `test-real.md`).
- [ ] Validar payout USDC na Base com `viem` (ver `test-real.md`).
- [x] Definir hardware e topologia (`docs/deployment.md`).

### Fase 1 — Banco e ledger

- [x] Migrações das tabelas novas (`0003` a `0006`).
- [x] Backfill da loja/xpub/cold wallet atuais via `ensureDefaultWallets` no boot.
- [x] Implementar ledger e invariantes.
- [x] Testes do ledger (unitários + integração).

### Fase 2 — Carteiras por loja e sweep

- [x] xpub/conta por loja via `MerchantWalletService.createBtcDeposit`.
- [x] `next_receive_index` por carteira (`merchant_wallet_state`).
- [x] Endereço de depósito por intent (`createIntentWithWalletAddress`).
- [x] Sweep para treasury BTC com fallback para `COLD_WALLET_ADDRESS`.
- [x] Atribuição de `merchant_id`/`wallet_id` em `payment_intents`.

### Fase 3 — Câmbio e intent

- [x] Adapters de taxa (`HttpFxPriceProvider` Coinbase + AwesomeAPI, fallback preparado).
- [x] `fx_quotes`, spread e expiração.
- [x] Intent aceitando `amount` + `currency` (ou `amount_sats`).
- [x] Persistência de `currency`, `amount_fiat` e `fx_quote_id` na intent.
- [x] Testes de arredondamento, parse e quote integrada no banco.

### Fase 4 — Treasury e conversão

- [x] Treasury BTC + signer (`RemoteTreasuryBtcSender`, ou manual sem signer).
- [x] Saque do LNbits para treasury (`TreasuryService` + bridge HTTP).
- [x] Adapter THORChain (`ThorchainClient`: quote multi-endpoint, limit e status).
- [x] Worker de conversão e polling (`ConversionService`).
- [x] Máquina de estados de conversão (`src/domain/conversion.ts`).
- [x] Idempotência e refund (`provider_events`, status `reembolsada`).
- [x] Lançamentos no ledger (recebimento BTC, conversão BTC->USDC e payout).
- [x] Configuração e exemplos de ambiente (THORChain, signer, LNbits bridge).
- [x] Migrações `0007` (quote/payout) e `0008` (idempotência do ledger).

### Fase 5 — Payout

- [x] Adapter Base USDC (`BaseUsdcPayoutAdapter` com `viem`).
- [x] Allowlist de carteira (`usdc_settlement` ativa + snapshot do destino).
- [x] Limite R$10k/USD por payout (`src/domain/payout.ts`).
- [x] Regra de decisão: automático / aprovação manual / retido.
- [x] Gas station ETH (checagem de saldo mínimo e retenção).
- [x] Payout imediato com agrupamento configurável (`payout_batch_seconds`).
- [x] Assinatura por chave local ou signer remoto (`PAYOUT_SIGNER_URL`).

### Fase 6 — API, admin e segurança

- [x] Escopos de API (`payments:*`, `wallets:*`, `balances:read`, `conversions:read`, `payouts:read`).
- [x] Endpoints de saldo, conversão, payout, carteiras e taxas.
- [x] Admin de aprovação, retry e reconciliação.
- [x] Webhooks novos (`converted`, `conversion_failed/refunded`, `payout_pending/sent/confirmed/failed`).
- [x] Rate limit global por API key e idempotência (`external_id`, endereço único, ações admin idempotentes).
- [x] Migração `0009` para escopos dos clientes.

### Fase 7 — Operação e endurecimento

- [x] Métricas e alertas (`GET /metrics`, alertas de jobs/sweep/conversao/payout/ledger).
- [x] Reconciliação diária (`ReconciliationService`, `reconciliation_runs`, job do worker).
- [x] Scripts de backup/restore com checksum e verificacao em banco descartavel.
- [x] Runbooks (`docs/runbook.md`, `docs/observability.md`, `docs/failure-drills.md`).
- [x] Harness de testes de falha (`npm run drills`) para execucao posterior.
- [x] Executar backup/restore em banco descartavel (`docs/drills-log.md`).
- [x] Executar drill nao destrutivo de dependencia indisponivel (`docs/drills-log.md`).
- [ ] Executar drills que dependem de Esplora/Base/signer de teste (ver `test-real.md`).
