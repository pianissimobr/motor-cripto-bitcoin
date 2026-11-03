# Contrato da integração única (v2) — app pessoal + site e-commerce

Documento de contrato escrito **antes** de qualquer código de produção (F0 do
plano). Ele fixa: quem é cada cliente do motor, quais endpoints existem, como o
endereço é provado e como o extrato agrega.

## 1. As duas frentes

```text
   APP (pessoal, sem login)                      SITE (e-commerce)
   ┌──────────────────────┐                      ┌────────────────────────┐
   │ cria carteira        │                      │ cadastro da loja       │
   │ → endereço 0xABC     │───QR / colar────────▶│ informa o 0xABC        │
   │ Pay Pix · Receive Pix│                      │ + prova de posse (C12)  │
   │ Extrato              │                      │ → merchant_wallets     │
   └──────────┬───────────┘                      └───────────┬────────────┘
              │  /v1/user/* (device HMAC + nonce)            │  /v1/* (HMAC da loja)
              └───────────────┬─────────────────────────────┘
                    ┌────────▼─────────┐
                    │  MOTOR           │  ← 1 chave LuniumPay
                    │  usuario: 0xABC  │     cash-in e cash-out
                    │  loja:    0xABC  │     para os dois perfis
                    └──────────────────┘
```

O app **não** autentica como lojista e **não** tem tela de login. O site não
conhece o app: o lojista cola (ou escaneia) o endereço que o app gerou. O
motor é o único que fala com a LuniumPay e o único que guarda a chave.

## 2. Decisões (v2)

| # | Decisão |
|---|---|
| D1 | Só o motor tem a chave LuniumPay de produção. O app nunca a vê. |
| D2 | App = perfil pessoal (pagar Pix, receber via Pix, extrato). |
| D3 | Cash-out (pagar Pix) entra no motor. |
| D4 | Sem login no app. |
| D5 | Motor = fonte da verdade; app = cache local. |
| D6 | Auth do app = cliente do motor por device (`api_key` + `request_secret` no Keychain, HMAC canônico). |
| D7 | `api_clients.client_type` = `loja` \| `usuario`. |
| D8 | Uma chave Lunium, um limite (60 req/min). |
| D9 | Trilho único **USDC/Polygon**. |
| D10 | O app assina localmente e reporta `tx_hash`. |
| D11 | Spread pago pelo lojista: `usuario` tem `spread_bps = 0`. |
| D12 | Checkout PIX público (`/pay/:id`) entra. |
| D13 | Namespace novo `/v1/user/*` para o perfil pessoal. |
| D15 | Tela de **Extrato** no app, com marcadores de pago/recebido. |
| D17 | Carteira stablecoin do app: **USDC/Polygon** (gas em POL). |
| D18 | O endereço do perfil pessoal vive em `api_clients.settlement_address` (não em `merchant_wallets`). |
| D19 | **Prova de controle do endereço** ao registrar cliente e ao cadastrar loja. |
| D20 | O extrato agrega **por endereço**: entradas de loja e de pessoa, indistintas. |

### Por que D18 (e não uma linha em `merchant_wallets`)

`merchant_wallets` tem índice único em `(chain, address)`. O mesmo endereço não
pode estar em duas carteiras na mesma chain — e o endereço do app é o mesmo que
o lojista cadastra no site. Por isso:

- `loja` → linha em `merchant_wallets` (`kind = usdc_settlement`);
- `usuario` → coluna `api_clients.settlement_address`.

A resolução do destino do cash-in fica em um lugar só
(`pix-charge-service.ts:194`, hoje `findActiveUsdcSettlementWalletForClient`):

```text
client_type = 'loja'    → merchant_wallets (usdc_settlement ativa)
client_type = 'usuario' → api_clients.settlement_address
```

## 3. Contratos

### C1 — Estados canônicos

O motor é quem traduz o estado do provedor. O app consome estados crus.

```text
criando | pendente | pago | liquidado | expirado | reembolsado | falhou | incerto | manual
```

Transições válidas (motor, `src/domain/pix.ts`): `criando → pendente →
pago → liquidado`, com saídas para `expirado`, `reembolsado`, `falhou`,
`incerto` e `manual`. Um estado final nunca volta.

### C2 — Cotação do cash-out

```http
POST /v1/user/cash-out-charges/quote
```

```json
{ "brl_amount": "50.00", "pix_key": "00000000191", "pix_key_type": "cpf" }
```

```json
{
  "brl_amount": "50.00",
  "asset": "USDC",
  "network": "polygon",
  "amount": "9.97",
  "fee_total_cents": 130,
  "expires_at": "2026-11-04T10:00:00.000Z"
}
```

Regra: `br_code` é exclusivo de `amount`/`brl_amount`/`pix_key` (400
`campos_conflitantes` se vierem juntos).

### C3 — Cria o cash-out

```http
POST /v1/user/cash-out-charges
```

```json
{ "external_id": "app-<uuid>", "brl_amount": "50.00", "pix_key": "00000000191", "pix_key_type": "cpf" }
```

```json
{
  "id": "uuid",
  "external_id": "app-<uuid>",
  "state": "AWAITING_DEPOSIT",
  "deposit_address": "0x...",
  "deposit_tag": null,
  "asset": "USDC",
  "network": "polygon",
  "amount": "9.97",
  "brl_amount": "50.00"
}
```

O endereço de depósito **só existe depois do `accept`** (a Lunium entrega o
endereço no aceite). `deposit_tag` é para redes com memo (solana, tron, xrp);
**na Polygon vem `null`** — verificado no sandbox em 2026-11-03.

### C4 — Reporta o depósito

```http
POST /v1/user/cash-out-charges/:id/deposit
{ "tx_hash": "0x..." }
```

O app assinou e transmitiu; o motor registra o hash para rastreabilidade.
Idempotente: repetir com o mesmo `tx_hash` não muda nada.

### C5 — Extrato do perfil pessoal

```http
GET /v1/user/operations?limit=50
```

```json
{
  "items": [
    {
      "id": "uuid",
      "direction": "entrada" | "saida",
      "kind": "pix_cashin" | "pix_cashout",
      "state": "liquidado",
      "settlement_status": "pago",
      "brl_amount": "50.00",
      "asset_amount": "9.97",
      "asset": "USDC",
      "network": "polygon",
      "tx_hash": "0x...",
      "e2e": "E0000000020261103...",
      "created_at": "...",
      "settled_at": "..."
    }
  ]
}
```

Agregação **por endereço** (D20): entradas =
`pix_charges.destination_address = X`; saídas = `cashout_charges.origin_address =
X`. A operação é a unidade de contagem (nada é duplicado quando o mesmo
endereço está em mais de um perfil).

O extrato é da **carteira**, não da loja: não mostra nome de loja, valor de
venda nem qualquer dado de merchant.

### C6 — Registra o cliente de device (perfil pessoal)

```http
POST /v1/user/clients
```

```json
{
  "address": "0xABC...",
  "chain": "polygon",
  "proof": { "nonce": "...", "signature": "0x..." },
  "altcha": "..."
}
```

```json
{ "api_key": "mk_btc_live_...", "request_secret": "...", "client_id": "uuid" }
```

O app guarda `api_key` e `request_secret` no Keychain/Keystore e assina as
chamadas com o HMAC canônico do motor (mesmo formato das lojas — zero código
novo no motor).

### C7 — (removido na v2) login e-commerce no app

### C8 — Destino do cash-in pessoal

`api_clients.settlement_address` (D18). Sem linha em `merchant_wallets`.

### C9 — Checkout PIX público

```http
GET  /pay/:id          → QR PIX + valor + destinatário
GET  /pay/:id/status   → { state, paid_at, e2e }
```

A rota é pública (o pagador não tem conta). Não expõe `client_id`. O polling
é do navegador a cada 5 s.

### C10 — Envelope de erro

```json
{ "error": { "code": "settlement_wallet_required", "message": "...", "details": {} } }
```

O app ramifica por `code`, nunca por `message`.

### C11 — Contrato compartilhado

OpenAPI do motor → geração de tipos no app. Uma fonte, dois lados.

### C12 — Prova de controle do endereço

O motor emite um nonce; o app assina com a chave EVM da carteira
(`personal_sign`/EIP-191); o motor confere com `viem`
(`verifyMessage`, que também cobre ERC-1271).

```http
POST /v1/user/challenges
→ { "nonce": "...", "message": "btc-payments: prova de posse\nendereço: 0xABC...\nnonce: ..." }

POST /v1/user/clients
{ "address": "0xABC...", "proof": { "nonce": "...", "signature": "0x..." } }
```

O nonce é de uso único, expira em 10 minutos e é gravado (replay é recusado).

### C13 — Cadastro da loja com o mesmo endereço

```http
POST /v1/portal/merchants/:id/wallets
{ "kind": "usdc_settlement", "chain": "polygon", "address": "0xABC...", "proof": { "nonce": "...", "signature": "0x..." } }
```

Sem prova, o cadastro é recusado. **Isso fecha um buraco que existe hoje**:
qualquer pessoa pode cadastrar o endereço de outra e desviar a liquidação.

## 4. Diff de schema

```ts
// src/db/schema.ts

// api_clients
clientType: text('client_type').$type<'loja' | 'usuario'>().notNull().default('loja'),
userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
// Endereço EVM do perfil pessoal: destino do cash-in dele.
// Fica em api_clients (e nao em merchant_wallets) porque merchant_wallets tem
// unique (chain, address) e o mesmo endereco pode ser o da loja.
settlementAddress: text('settlement_address'),
// (novo indice) uniqueIndex('api_clients_settlement_address_uq')
//   .on(table.settlementAddress).where(sql`settlement_address is not null`),
// (novo indice) index('api_clients_user_idx').on(table.userId),
// (novo indice) index('api_clients_client_type_idx').on(table.clientType),

// api_clients.settlement_chain: 'base' -> 'base' | 'polygon'
// api_clients.spread_bps: 'usuario' => 0 (nao ha spread no perfil pessoal)

// merchant_wallets.chain: 'base' -> 'polygon' (as lojas existentes migram)

// pix_charges.chain: 'base' -> 'base' | 'polygon'

// Tabela nova: cashout_charges (espelho de pix_charges)
export const cashoutCharges = pgTable(
  'cashout_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => apiClients.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    provider: text('provider').$type<'lunium'>().notNull().default('lunium'),
    providerExternalId: text('provider_external_id').notNull(),
    providerCashoutId: text('provider_cashout_id'),
    providerStatus: text('provider_status').$type<string>(),
    state: text('state').$type<
      'criando' | 'pendente' | 'aguardando_deposito' | 'depositado' | 'pago' | 'liquidado' | 'falhou' | 'incerto' | 'manual'
    >().notNull().default('criando'),
    amountBrlCents: bigint('amount_brl_cents', { mode: 'bigint' }).notNull(),
    asset: text('asset').$type<'USDC'>().notNull().default('USDC'),
    network: text('network').$type<'polygon'>().notNull().default('polygon'),
    // Endereço de onde o USDC saiu: e o agregador do extrato (C5).
    originAddress: text('origin_address').notNull(),
    // Endereço de deposito da Lunium (destino do cash-out).
    depositAddress: text('deposit_address'),
    depositTag: text('deposit_tag'),
    amountAssetMinor: bigint('amount_asset_minor', { mode: 'bigint' }),
    feeTotalCents: bigint('fee_total_cents', { mode: 'bigint' }),
    txHash: text('tx_hash'),
    e2e: text('e2e'),
    pixKeyMasked: text('pix_key_masked'),
    providerPayload: jsonb('provider_payload').$type<Record<string, unknown> | null>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('cashout_charges_client_external_uq').on(table.clientId, table.externalId),
    uniqueIndex('cashout_charges_provider_external_uq').on(table.provider, table.providerExternalId),
    index('cashout_charges_origin_idx').on(table.originAddress),
    index('cashout_charges_state_idx').on(table.state),
  ],
);

// Tabela nova: api_challenges (prova de posse)
export const apiChallenges = pgTable(
  'api_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nonceHash: text('nonce_hash').notNull(),
    purpose: text('purpose').$type<'settlement_address'>().notNull(),
    address: text('address'),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('api_challenges_nonce_uq').on(table.nonceHash)],
);
```

**Ordem das migrations:** (1) colunas novas em `api_clients`; (2) tabela
`cashout_charges`; (3) tabela `api_challenges`; (4) `settlement_chain` e
`chain` passando a aceitar `polygon`; (5) migrar `merchant_wallets.chain` de
`base` para `polygon` (mesmo endereço EVM, 0 cobrancas PIX hoje, dispara
`merchant.wallet_changed`).

## 5. Idempotência

| Nível | Chave |
|---|---|
| App → motor | `external_id` do app = `external_id` do motor (mesmo valor). |
| Motor → Lunium | `provider_external_id` = `pix_<uuid>` / `cashout_<uuid>`. |
| Lunium | `external_id` na criação + `GET /cashin/charges?external_id=`. |

Repetir a mesma requisição com o mesmo `external_id` **não** cria uma segunda
operação nem cobra de novo.

## 6. Limites (medidos na chave de produção, 2026-11-03)

| Limite | Valor | Origem |
|---|---|---|
| Requisições por minuto | 60 | `GET /keys/me` → `rate_limit_per_minute` |
| Cash-out por transação | R$ 6,00 – R$ 250.000,00 | `GET /keys/me` → `limits.cashout` |
| Teto diário de cash-out | sem teto (o limite é por transação) | idem |
| Cash-in por cobrança | R$ 1,02 – R$ 6.000,00 | `GET /keys/me` → `limits.cashin` |
| Cash-in mínimo USDC/Polygon | R$ 6,90 (taxa de saque 0,018 USDC) | `GET /cashin/catalog` |
| Taxa da Lunium | 3,3% + R$ 1,00 por compra direta | `GET /keys/me` → `fee_bps` |
| Sub-fee de parceiro | 0 (todas) | `GET /keys/me` → `comissao` |

O motor fatia o limite de 60 entre os dois processos (`LUNIUM_RATE_LIMIT_API_MAX`
= 20, `LUNIUM_RATE_LIMIT_WORKER_MAX` = 25, soma abaixo do total).

## 7. Achados empíricos (sandbox e produção, 2026-11-03)

| Achado | Consequência |
|---|---|
| Produção: trilho rápido do cash-out = **USDT/polygon, USDC/polygon** e DEPIX/liquid | USDC/Polygon é válido nos dois sentidos (D9/D17) |
| Produção: cash-in entrega USDC/polygon (mín. R$ 6,90, saque 0,018) e USDC/base (mín. R$ 7,30, saque 0,1) | Polygon é o trilho mais barato |
| **Sandbox: o catálogo do cash-out só tem USDT/polygon** — USDC/polygon é recusado (`asset_invalido`) | O app com USDC/Polygon **não fecha cash-out no sandbox** até a LuniumPay incluir USDC/polygon no catálogo de teste |
| **Produção: o cash-in não manda `asset_amount`** — o entregue vem em `delivery_accounting.aSacar` (1,55802042 para R$ 10,00) | O motor lê o `aSacar`; o `usdt_amount` (1,5820698) é o **comprado**, e usá-lo como mínima reprovaria a entrega |
| **As taxas (`fee_total_cents`, `net_cents`) só vêm dentro de `delivery_accounting`** | O extrato do app precisa ler de lá |
| **`under_review` entre o Pix pago e a entrega** (~2 min): a Lunium confere o pagador | Virou `manual` no motor (com alerta) — não é pendência |
| **Produção: a entrega usa o USDC nativo da Polygon** (`0x3c499c54…`), `Transfer` de 1,558020 USDC | Confirmado on-chain; o bridged segue na lista por robustez |
| **A chave de produção tem `chain: polygon`; o motor falava Base** | Corrigido: `PIX_CHAIN=polygon`, `POLYGON_*` |
| **Os limites do cash-in do motor divergiam da chave** (2500–25.000.000 vs 102–600.000) | Corrigido: o default agora é o da chave |
| Cash-out: `deposit_address` só vem no `accept`; `deposit_tag` é `null` na Polygon | O trilho é viável: não há memo na Polygon |
| Cash-in: `settlement_status` vira `sent` alguns segundos depois do pagamento | `pago` e `liquidado` são estados diferentes; o app não pode Treating "pago" como "entregue" |
| Sandbox: `asset_amount` não vem, só o legado `usdt_amount` | O motor aceita os dois (usa o legado quando `sandbox=true`) |
| Sandbox: `settlement_tx_hash` é `sandbox:<hash>` (não existe on-chain) | No sandbox, `PIX_VERIFY_SETTLEMENT_TX=false` |
| A chave de produção tem `chain: polygon` | O motor precisa falar Polygon (F1) |
| `settlement_tx_hash` pode ser "id interno quando a entrega é pela corretora" | A verificação on-chain do motor precisa tolerar entrega sem hash real (ou o motor cai em `manual`) |

**Ponto em aberto que só a primeira entrega real fecha:** qual contrato de USDC
a Lunium usa na Polygon (nativo `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
ou bridged `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`). Até la, a
verificação do motor deve aceitar **as duas** (lista de endereços), para a
primeira entrega real não travar em `manual`.

## 8. Estado em 2026-11-03

| Fase | Situação |
|---|---|
| F0 (contrato e schema) | ✅ este documento |
| F1 (cash-out no motor + Polygon) | 🟡 a **chain** e a verificação on-chain estão prontas e validadas em produção; falta a tabela `cashout_charges` e o serviço de cash-out |
| F2 (cliente de device + prova de posse + rate limiter) | 🟡 o **rate limiter** está pronto (60 req/min fatiados entre API e worker); faltam o cliente de device (`/v1/user/clients`) e a prova de posse |
| F3 (checkout PIX público + extrato) | ⬜ |
| F4 (site: cadastro da loja com o endereço do app) | ⬜ |
| F5 (app: gateway abstrato) | ⬜ |
| F6 (app: perfil pessoal) | ⬜ |
| F7 (operação: e-mail, alertas, conformidade) | 🟡 limite e conciliação prontos; falta ligar o e-mail (SMTP) e decidir a questão regulatória |

**Validação de ponta a ponta em produção:** uma cobrança de R$ 10,00 paga de
verdade, conferida on-chain (`liquidado`), com E2E do Banco Central e o
`settlement_tx_hash` registrado.

## 9. Fases (ordem de ataque)

| Fase | Entrega | Critério de aceite |
|---|---|---|
| F0 | este documento + diff de schema | contrato revisado |
| F1 | cash-out no motor + migração Base → Polygon | cash-out de sandbox fecha |
| F2 | cliente de device + prova de posse + rate limiter | 200+ cobranças sem estourar 60/min |
| F3 | checkout PIX público + extrato | E2E sandbox do `/pay/:id` |
| F4 | site: cadastro da loja com o endereço do app + prova | endereço sem prova é recusado |
| F5 | app: gateway abstrato (interface + adapter do motor) | nenhum import de `lunium` fora do gateway |
| F6 | app: perfil pessoal (extrato, pagar, receber, QR de posse) | E2E do app contra o motor |
| F7 | operação: uma chave, um limite, runbook, conformidade | alertas unificados |

## 10. Em aberto

**Resolvidos em 2026-11-03** (mediros, não presumidos):

1. ✅ Contrato de USDC na Polygon: **nativo** (`0x3c499c54…`).
2. ✅ `deposit_tag` na Polygon: `null` — o trilho é viável.
3. ✅ A chave de produção tem `chain: polygon` — o motor migrou.
4. ✅ Os limites do cash-in: `GET /keys/me` → `limits.cashin` = 102–600000.

**Ainda em aberto:**

5. 🔶 `settlement_tx_hash` como id interno (entrega pela corretora) — o motor
   precisa de um caminho de liquidação sem hash on-chain. Na entrega real veio
   hash de verdade, mas a API não garante.
6. 🔶 Sandbox sem USDC/polygon no catálogo de cash-out — pedir à LuniumPay
   (a produção tem o par).
7. 🔶 Prova de posse no site: QR obrigatório ou colar o endereço?
8. 🔶 `external_id` do app = `external_id` do motor (idempotência ponta a
   ponta) — a Lunium aceita o mesmo id nos dois lugares, mas precisa
   confirmar.
9. 🔶 E-mail do motor sem relay SMTP: sem ele, ninguém redefine senha.
10. 🔶 Os limites da chave não são relidos em runtime: se a Lunium mudar a
    faixa, o motor descobre no erro.
