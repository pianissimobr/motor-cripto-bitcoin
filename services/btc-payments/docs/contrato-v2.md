# Contrato da integração única (v3) — app pessoal + site e-commerce

Documento de contrato escrito **antes** de qualquer código de produção (F0 do
plano). Ele fixa: quem é cada cliente do motor, quais endpoints existem, como o
endereço é provado e como o extrato agrega.

> **v3 (2026-11-04)** — fecha as decisões que faltavam depois das duas
> operações reais (cash-in de R$ 10,00 e cash-out de R$ 6,50) e da leitura
> da API da LuniumPay (1.44.2 / 1.50.0). O que mudou: **D21–D32** (decisões),
> **C2, C3, C5, C6 e C12** (contratos revisados) e a **tabela de rotas**
> (§3.1), que é o que os dois lados implementam. O resto do documento vale
> como estava.

## 1. As duas frentes

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

### Decisões do v3 (2026-11-04)

| # | Decisão | Porquê |
|---|---|---|
| D21 | **Hierarquia de identidade**: `endereço` (0x) é a raiz → `client_id` (credencial, substituível) → `external_id` (operação). O histórico é indexado **por endereço**: sobrevive à troca de credencial. | O app é descartável (a seed é o backup, não o app). Se o histórico morasse na credencial, perder o celular perderia o extrato. |
| D22 | **O cliente do motor é uma carteira criada no app** — pessoa e loja são o mesmo registro (`client_type` + `settlement_address`); o site é só a superfície onde a loja se cadastra. | Tudo nasce igual: carteira → `client_id`. A loja não é um tipo diferente de cliente. |
| D23 | **Valor sempre em centavos explícitos**: `amount_cents` (inteiro) ou `brl_amount` ("50.00"). **Nunca `amount`**, que diverge por 100× entre o app (centavos) e o motor (reais). | Um nome ambíguo entre dois lados é um bug esperando. |
| D24 | **Uma chave LuniumPay** para o motor (a que já existe). A Lunium não modela chave por cliente: a chave é do *projeto*; o cliente final só aparece como pagador ou recebedor, por operação. | `POST /keys` só aceita `name` (nome do negócio). O que existe por cliente (`customer_ref`) é **sub-conta de saldo em custódia** — o oposto do app não-custodial. |
| D25 | **A.identifieria por cliente vive no motor**, e a justiça de cota também: o limitador do motor é **fair-share por `client_id`**, com teto global. | A cota de 60 req/min é **por chave** (Lunium). Com uma chave, app e lojas disputam; o app (polling) pode estrangular o checkout das lojas — que é a receita. |
| D26 | **Sub-fee é `partner_fee_bps`** (0–1000), não `spread_bps`: é a comissão do integrador **por cima** da `fee_bps` da Lunium, paga pelo usuário final. `spread_bps` não existe na API da Lunium. | Confundir taxa da Lunium com spread nosso faz o cálculo de margem errar. |
| D27 | **Polling**: refresh por operação a cada 10–15 s (a Lunium avisa que 1/s consome a cota); **lista do extrato** a cada 30–60 s e no foreground. | A lista é a operação cara; operação viva é a que precisa de detalhe. |
| D28 | **O motor valida o BR Code** (prefixo EMV + CRC16) e recusa com 400 `br_code_invalido`; não confia no parse do app. | Com o virando cliente de API, a confiança no app muda de natureza. |
| D29 | **O motor expõe o estado canônico dele** + `provider_state` (cru da Lunium). O app traduz. | A Lunium é a fonte do *fato*; o motor é a fonte do *estado do produto*. Um vocabulário só, para os dois lados. |
| D30 | **A cotação (`quote`) é efêmera**: não persiste, não consome `external_id`. Só o `POST` de criação persiste e é idempotente. | Cota e estado do motor são para operações, não para prévias. |
| D31 | **`GET /v1/user/operations`** traz paginação por cursor, `updated_at` e um **marcador de origem** (`pessoal` \| `loja`), sem nome de loja nem dado de merchant. | O extrato é da carteira; o marcador diz "isto veio de uma loja" sem vazar o nome. |
| D32 | **A LuniumPay tem `nivel_conta`** (`padrao` \| `vip_master`): em `vip_master` não há taxa fixa por Pix, nem escada por pagador, e o CPF/CNPJ do pagador é **opcional**. Não há API para mudar o nível — é decisão comercial da Lunium (lead filed em 2026-11-04, `lead_id` 69). | No `padrao`, cada entrada Pix custa R$ 1,00 fixos + documento do pagador — 10% de um Pix de R$ 10,00. |

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
`campos_conflitantes` se vierem juntos). **v3:** a cotação é **efêmera** — não
persiste, não consome `external_id` (D30). O `br_code` é validado pelo motor
(prefixo EMV + CRC16) e recusado com 400 `br_code_invalido` (D28).

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
  "state": "aguardando_deposito",
  "provider_state": "AWAITING_DEPOSIT",
  "deposit_address": "0x...",
  "deposit_tag": null,
  "asset": "USDC",
  "network": "polygon",
  "amount": "9.97",
  "brl_amount": "50.00",
  "origin_address": "0x...",
  "expires_at": "2026-11-04T10:00:00.000Z"
}
```

O endereço de depósito **só existe depois do `accept`** (a Lunium entrega o
endereço no aceite). `deposit_tag` é para redes com memo (solana, tron, xrp);
**na Polygon vem `null`** — verificado no sandbox em 2026-11-03.

**v3:**
- o `state` é o **canônico do motor** (D29) e o `provider_state` é o cru da
  Lunium, para quando o app precisar mostrar o vocabulary do provedor;
- `origin_address` é o endereço de onde o USDC sai — é o agregador do extrato
  (C5) e vem do `settlement_address` do cliente (D18/D22), não do corpo;
- o `external_id` do app é a chave de idempotência: mesmo `external_id` +
  mesmo corpo devolvem a mesma ordem (200); `external_id` com dados diferentes
  é 409.

### C3.1 — Tabela de rotas (o que os dois lados implementam)

| Rota | Escopo | Request | Response |
|---|---|---|---|
| `POST /v1/user/cash-out-charges/quote` | `cashout:write` | `{brl_amount? \| amount_cents?, pix_key?, pix_key_type?, br_code?, refund_address?}` | `{brl_amount, asset, network, amount, fee_total_cents, expires_at}` |
| `POST /v1/user/cash-out-charges` | `cashout:write` | `{external_id, brl_amount? \| amount_cents?, pix_key?, pix_key_type?, br_code?, refund_address?}` | ordem (C3) |
| `GET /v1/user/cash-out-charges/:id` | `cashout:read` | — | ordem (C3) |
| `POST /v1/user/cash-out-charges/:id/deposit` | `cashout:write` | `{tx_hash}` | 204 |
| `POST /v1/user/cash-out-charges/:id/refund-address` | `cashout:write` | `{refund_address}` | ordem (C3) |
| `GET /v1/user/operations` | `operations:read` | `?limit=&cursor=` | extrato (C5) |
| `POST /v1/user/gas/topup` | `gas:write` | `{address, chain, amount_wei?}` | `{amount_wei, tx_hash, chain}` |
| `GET /v1/user/payer-limits` | `operations:read` | `?payer_tax=` | escada do pagador (da Lunium) |
| `POST /v1/user/challenges` | — (público) | `{purpose, address?}` | `{nonce, message, expires_at}` |
| `POST /v1/user/clients` | — (público) | `{address, chain, proof}` | `{client_id, api_key, request_secret}` (C6) |
| `POST /v1/pix-charges` | `payments:write` | `{external_id, amount_cents \| amount, currency, payer_tax_number, payer_name?, metadata?}` | cobrança (como hoje, com `amount_cents`) |

Envelope de erro (nos dois lados): `{error: {code, message, details?}}` — o app
ramifica por `code`, nunca por `message`.

### C4 — Reporta o depósito

```http
POST /v1/user/cash-out-charges/:id/deposit
{ "tx_hash": "0x..." }
```

O app assinou e transmitiu; o motor registra o hash para rastreabilidade.
Idempotente: repetir com o mesmo `tx_hash` não muda nada.

### C5 — Extrato do perfil pessoal

```http
GET /v1/user/operations?limit=50&cursor=<id>
```

```json
{
  "items": [
    {
      "id": "uuid",
      "direction": "entrada" | "saida",
      "kind": "pix_cashin" | "pix_cashout",
      "origin": "pessoal" | "loja",
      "state": "liquidado",
      "settlement_status": "pago",
      "brl_amount": "50.00",
      "asset_amount": "9.97",
      "asset": "USDC",
      "network": "polygon",
      "tx_hash": "0x...",
      "e2e": "E0000000020261103...",
      "receipt_url": "https://...",
      "verify_url": "https://...",
      "created_at": "...",
      "updated_at": "...",
      "settled_at": "..."
    }
  ],
  "next_cursor": "id-da-ultima-pagina"
}
```

Agregação **por endereço** (D20): entradas =
`pix_charges.destination_address = X`; saídas = `cashout_charges.origin_address =
X`. A operação é a unidade de contagem (nada é duplicado quando o mesmo
endereço está em mais de um perfil).

O extrato é da **carteira**, não da loja: não mostra nome de loja, valor de
venda nem qualquer dado de merchant.

**v3:**
- paginação por cursor (`next_cursor`), `updated_at` sempre presente — o app
  faz *upsert* por `id` e sabe o que mudou (D31);
- `origin` diz **de onde** veio (`pessoal` \| `loja`), sem dizer qual loja
  (D31);
- o app mostra o **detalhe** da operação (E2E, comprovante, recebedor
  mascarado, endereço de depósito no cash-out) — é o que dá confiança de que
  o Pix foi para quem o usuário queria;
- o saldo da carteira **não vem do motor**: é lido on-chain. O extrato é a
  narrativa dos movimentos, o saldo é a verdade do dinheiro.

### C6 — Registra o cliente de device (perfil pessoal)

```http
POST /v1/user/clients
```

```json
{
  "address": "0xABC...",
  "chain": "polygon",
  "proof": { "nonce": "...", "signature": "0x..." }
}
```

```json
{ "client_id": "uuid", "api_key": "mk_btc_live_...", "request_secret": "..." }
```

O app guarda `api_key` e `request_secret` no Keychain/Keystore e assina as
chamadas com o HMAC canônico do motor (mesmo formato das lojas — zero código
novo no motor).

**v3:**
- a resposta é em **snake_case** (`api_key`, `request_secret`) — o
  `POST /admin/api/clients` devolve `apiKey`/`requestSecret`, e essa
  divergência já enganou quem integrou;
- o `client_id` é o **"id do mobile"** (D21): a identidade técnica do
  aparelho. A identidade real é o **endereço**;
- a **prova de posse é obrigatória** (C12): sem ela, qualquer um abriria um
  cliente e consumiria a cota de 60 req/min da chave;
- **um cliente ativo por endereço**: pedir de novo devolve o mesmo
  `client_id` (o usuário que perdeu a credencial se re-registra sem perder o
  histórico, que é por endereço — D21);
- o `settlement_address` do cliente é o endereço da carteira, e é ele que
  recebe o USDC do cash-in (C8) e de onde sai no cash-out (C3).

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

**v3 — revogação (C12.1).** A loja cadastra o endereço do usuário como
carteira de liquidação (C14). Isso é legítimo (o dinheiro é da loja), mas
qualquer um pode cadastrar o endereço de outra pessoa. Enquanto o C14 completo
(obrigar prova da loja) está fora do escopo, o mínimo é:

- o motor **marca** a operação como `origin: "loja"` no extrato do dono do
  endereço (C5) — o usuário vê que aquela entrada não é dele;
- o **app** pode **revogar** o registro: `POST /v1/user/address-revocations`
  com `{address, merchant_id}` → a loja perde o destino e cadastra outro
  (com prova, quando o C14 entrar).

A revogação é o controle que substitui o C14 no escopo atual — e é feito
pelo app (a loja não decide sobre o endereço do outro).

### C13 — Gas: a política e a "gas station" (novo)

O gas **não é automático**: pagar um Pix é uma transferência ERC-20 comum e o
gas sai da carteira de quem paga. A LuniumPay paga o gas do *sweep* dela e do
Pix, não o seu envio.

Medido na Polygon (2026-11-03): **61.001 gas** por envio = 0,0169 POL a
277 gwei (0,0244 a 400 gwei).

**No app** (`blue_modules/lunium/gas-policy.ts`):

| Conceito | Valor |
|---|---|
| custo | `gasLimit x precoBase` |
| pior caso (o que o app aceita assinar) | `custo x 2` |
| alvo do saldo nativo | `min(0,05 POL, pior caso x 2 envios)` |
| reposição | `alvo - saldo` (ou seja, o que a última operação consumiu) |

**No motor** (a automatização de verdade): uma *gas station* — o motor tem uma
tesouraria de POL e reembolsa o gas:

```http
POST /v1/user/gas/topup
{ "address": "0xABC...", "chain": "polygon", "amount_wei": "50000000000000000" }
→ { "amount_wei": "50000000000000000", "tx_hash": "0x...", "chain": "polygon" }
```

- escopo `gas:write` (fora do padrão dos clientes novos: uma chave vazada não
  podeples para repor gas);
- o motor envia POL da tesouraria para a carteira do usuário (chave isolada em
  `GAS_STATION_PRIVATE_KEY`, só para isso);
- teto por reposição (`GAS_STATION_MAX_TOPUP_WEI`, 0,05 POL) e piso da
  tesouraria (`GAS_STATION_MIN_TREASURY_WEI`): a reposição é só para a próxima
  operação, não para encher a carteira de gas;
- o custo (R$ 0,012 por operação) é absorvido pelo motor ou reembolsado no
  extrato do usuário em USDC.

**O que a LuniumPay não faz (medido em 2026-11-03):** ela **não entrega POL
na Polygon** (`"rota POL/polygon não está disponível para saque agora"`), e o
único POL do catálogo é o ERC-20 na Ethereum (mínimo de US$ 50) — que não paga
gas na Polygon. Por isso a troca "dólar → POL" **não acontece na carteira do
usuário**: ela seria uma transação e precisaria do gas que ela mesma produz.
A tesouraria do motor é o que resolve.

**Funding da tesouraria:** com o que o motor ganha (a taxa da LuniumPay e,
depois, a comissão de parceiro). O saldo accumulates em USDC e, quando o POL
baixa do piso, o motor troca USDC→POL numa DEX — operação de servidor, com
gas de servidor.

### C14 — Cadastro da loja com o mesmo endereço

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
| **O cash-out não manda `asset_amount` e o `usdt_amount` é o valor comprado** | Idem: o valor entregue vem de `delivery_accounting.aSacar` |
| **O gas do cash-out sai da carteira de quem paga** (61.001 gas = 0,0169 POL) | Política de gas no app + gas station no motor (C13) |
| **O `cash-out` não exige o documento do recebedor** (a documentação diz que exige, para chave de e-mail) | A API aceitou a ordem e o aceite sem `tax_number`; o risco fica no provedor do Pix |
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

## 8. Estado em 2026-11-04

| Fase | Situação |
|---|---|
| F0 (contrato e schema) | ✅ este documento (v3) |
| F1 (cash-out no motor + Polygon) | 🟡 **em andamento**: a chain, a verificação on-chain e o **fluxo real do cash-out** (app → Lunium → Pix pago) estão validados em produção; falta o serviço no motor (tabela `cashout_charges`, rotas, job) |
| F2 (cliente de device + prova de posse + rate limiter) | 🟡 o **rate limiter** está pronto; falta o cliente de device (`/v1/user/clients`) e a prova de posse |
| F3 (checkout PIX público + extrato) | ⬜ (o checkout público de BTC existe; o extrato por endereço, não) |
| F4 (site: cadastro da loja com o endereço do app) | ⬜ |
| F5 (app: gateway abstrato) | ✅ pronto e verificado contra o motor real (HMAC aceito, escopo `gas:write` recusado sem permissão, gas station respondendo) |
| F6 (app: perfil pessoal) | 🟡 falta a **tela de registro do device** (sem ela o app ainda fala direto com a LuniumPay) e a tela de extrato |
| F7 (operação: e-mail, alertas, conformidade) | 🟡 limite, conciliação e SMTP prontos; falta ligar o relay e a decisão regulatória |

**Validações de ponta a ponta em produção:**

- **cash-in**: cobrança de R$ 10,00 paga de verdade, conferida on-chain
  (`liquidado`), E2E `E20855875202611031543SX9I9XU27IJ`, tx
  `0xb80bf950079fe715cbe7c7291fbc76cd5bcaf5bf6a1151cd691ad4578f6c223b`
  (1,558020 USDC nativo na Polygon).
- **cash-out**: R$ 6,50 para `adm@pianolabribeirao.com.br` — Pix pago, E2E
  `E3729393020261104024702905451d07`, tx do depósito
  `0xa2a9242d774f6a1078d23ba2231e62fc4f596f9acd8a4be39258c0dddd37f367`
  (1,436256 USDC). O gas (0,0219 POL) veio da **gas station** do motor, que
  repôs 0,05 POL na carteira.
- **gas station**: `POST /v1/user/gas/topup` devolveu `201` com receipt
  `status 0x1` (tesouraria `0x4Cd01696…3855`).

> **Bug encontrado e corrigido no caminho** (2026-11-04): a transação legacy do
> app era assinada com `v = recovery + 27 + chainId * 2` em vez de `35` (EIP-155).
> O nó lia um chainId 4 unidades menor e recusava **toda** transação ("invalid
> chain id for signer: have 133 want 137") — ou seja, nenhum cash-out assinado
> pelo app passaria. O teste de conformidade comparava só o digest e repetia a
> mesma convenção errada; agora compara a transação serializada **byte a byte**
> com a do `ethers`.

### Alternativa considerada e descartada: `/carteira-usdt`

A LuniumPay passou a oferecer **carteira USDT/USDC própria** (`/carteira-usdt`):
o usuário deposita nela e paga Pix do saldo — sem assinar nada e sem gas. É o
caminho **custodiante** (a Lunium guarda o dinheiro; existe o erro
`custodia_desligada` para desligar por chave). **Descartado**: a fork é
não-custodial e a chave nunca sai do aparelho. Fica registrado para não se
reinventar.

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

**Resolvidos** (medidos, não presumidos):

1. ✅ Contrato de USDC na Polygon: **nativo** (`0x3c499c54…`).
2. ✅ `deposit_tag` na Polygon: `null` — o trilho é viável.
3. ✅ A chave de produção tem `chain: polygon` — o motor migrou.
4. ✅ Os limites do cash-in: `GET /keys/me` → `limits.cashin` = 102–600000.
5. ✅ **A chave LuniumPay é do projeto, não do cliente** (D24): `POST /keys` só
   aceita `name`/`email`/`settlement_address`/`webhook_url`/`lead_token`; o
   cliente final aparece como pagador ou recebedor, por operação. O conceito
   de "cliente" que existe (`customer_ref`) é sub-conta de **saldo em custódia**
   — fora do modelo não-custodial.
6. ✅ **Uma chave só** (D24), com **fair-share por `client_id`** no motor
   (D25).
7. ✅ **`spread_bps` não existe na Lunium** (D26): a nossa comissão é
   `partner_fee_bps` (hoje 0 na chave `libreflow`).
8. ✅ **`nivel_conta`**: existe na spec 1.50.0, só em resposta — não há API
   para mudar. No `padrao` (o nosso hoje) são R$ 1,00 fixos por Pix e CPF do
   pagador obrigatório. Pedido o `vip_master` via `POST /leads` em 2026-11-04
   (`lead_id` 69); a resposta trouxe `lead_token`, que só pode ser vinculado a
   uma chave **nova** — a nossa já existe, então o vínculo é do lado deles.
9. ✅ O `v` da EIP-155 do app (bug que impedia qualquer cash-out assinado) —
   corrigido e com teste que compara a tx byte a byte com a do `ethers`.
10. ✅ Divergências app↔motor fechadas no v3: unidade do valor (`amount_cents`
    × `brl_amount`, D23), `payout_address` fora do corpo (o destino vem do
    cliente), vocabulário de estado (D29), `br_code` exclusivo e validado pelo
    motor (D28), envelope de erro por `code`.

**Ainda em aberto:**

11. 🔶 `settlement_tx_hash` como id interno (entrega pela corretora) — o motor
    precisa de um caminho de liquidação sem hash on-chain. Na entrega real veio
    hash de verdade, mas a API não garante.
12. 🔶 Sandbox sem USDC/polygon no catálogo de cash-out — pedir à LuniumPay
    (a produção tem o par).
13. 🔶 C14 (prova de posse da loja) fora do escopo atual; no lugar fica o
    marcador `origin: "loja"` + a revogação pelo app (C12.1).
14. 🔶 E-mail do motor sem relay SMTP: sem ele, ninguém redefine senha.
15. 🔶 Os limites da chave não são relidos em runtime: se a LuniumPay mudar a
    faixa, o motor só descobre no erro.
16. 🔶 `GET /v1/user/payer-limits` não existe no motor (o app já chama):
    falta a rota que delega `GET /cashin/limits?payer_tax=`.
17. 🔶 Cota: com uma chave, o teto é 60 req/min no total. O fair-share por
    `client_id` está no desenho (D25) e ainda não foi implementado; a
    cadência de polling do app também (D27).
