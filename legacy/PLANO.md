# Plano — Motor de Pagamentos Ramp (pessoal) → Carteira Fria

> Histórico. Este arquivo descreve o motor Polygon/Ramp em `src/` (porta 4578).
> O serviço atual de Bitcoin está em `services/btc-payments`. O livro dele é `web/docs/index.html`.

> Documento de conferência. Gerado antes da implementação.
> Porta do servidor: **4578** (Postgres em 5432).

## 1. Decisões fechadas

| Item | Decisão |
|---|---|
| "id do ramp" | Tabela `ramp_profiles` (id, label, chain, asset, contrato, decimais, fiat, base_url, param_style) — o form referencia o id |
| Stack | Node 22 + TypeScript + Fastify 5 + Drizzle ORM + Postgres 16 (Docker Compose) |
| Assinatura | Interface `Signer` plugável: `LocalSigner` (default) + `RemoteSigner` + `PsbtSigner` |
| Rede | Polygon mainnet, multi-chain configurável (perfis definem chain+token); Amoy para teste |

## 2. Achados técnicos que mudam o `projetoo.md`

Três correções necessárias antes de codar:

1. **Xpub não pode derivar `m/44'/60'/0'/0/{i}`**. Os passos `44'`, `60'`, `0'` são *hardened* — impossível a partir de um xpub. Confirmado no código do ethers v6 (`ser_I` lança `cannot derive child of neutered node`). **Solução**: o motor usa o **xpub de conta** (`m/44'/60'/0'`, depth 3) e deriva o caminho **relativo** `0/{index}`. O motor valida o `depth` do xpub e rejeita com mensagem clara.
2. **Endereços derivados não têm POL**. O sweep de ERC-20 exige gas nativo — e um endereço HD recém-derivado tem saldo 0. **Solução**: padrão *gas sponsor*: uma carteira patrocinadora envia ~0,5 POL para o endereço, que então assina o `transfer` para a carteira fria. Custo por link ≈ R$ 0,10.
3. **Endereço do USDC está com typo no doc**: `...ce70d5cC03d5c3359` → correto `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (6 decimais, verificado on-chain). USDT0: `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` (6 decimais).

Também: `polygon-rpc.com` agora exige API key (403); `polygon-bor-rpc.publicnode.com` responde normalmente. `buy.ramp.network` não é alcançável deste sandbox (mas `app.rampnetwork.com` é) — a base URL fica configurável por perfil.

## 3. Arquitetura do motor (ports & adapters)

O objetivo é que o core sirva em outros apps. Regra: **`src/core` não importa Fastify, Drizzle nem ethers** — só `ethers` (para ECDSA/ABI) e `zod`.

```
motor-cripto/
├── src/
│   ├── core/                    # O MOTOR — sem framework, importável por qualquer app
│   │   ├── index.ts             # createMotor(config) → { customers, links, monitor, sweeper, credits }
│   │   ├── config.ts            # zod: validação de env, falha cedo
│   │   ├── domain/              # tipos, estados, invariantes
│   │   ├── hd/                  # derivação xpub, alocação de índice, validação de depth
│   │   ├── ramp/                # construtor de URL (param_style: legacy | unified)
│   │   ├── chain/               # monitor (getLogs), confirmations, sweep, gas
│   │   ├── signer/              # Signer interface + LocalSigner/RemoteSigner/PsbtSigner
│   │   ├── crypto/              # AES-256-GCM envelope, blind index HMAC, redaction
│   │   └── ports/               # interfaces de repositório (CustomerRepo, LinkRepo...)
│   ├── adapters/
│   │   ├── db/                  # Drizzle: schema, migrations, implementações dos ports
│   │   └── http/                # Fastify: rotas = adaptador fino sobre o core
│   ├── worker/                  # processo monitor + sweeper (advisory lock no Postgres)
│   └── server.ts                # boot do HTTP
├── web/                         # 2 páginas HTML (vanilla, sem CDN)
├── db/migrations/
├── scripts/init-wallet.ts       # gera mnemonic + xpub + keystore cifrado
└── docker-compose.yml
```

**Contrato do core** (exemplo de uso em outro app):

```ts
const motor = await createMotor({ db, signer, chain, ramp, ... });
const { link } = await motor.links.create({ customerId, amount, rampProfileId, coldWallet });
```

## 4. Modelo de dados

Dinheiro **nunca em float**: fiat em centavos (int), token em base units (`bigint`).

**Núcleo pedido:**

| Tabela | Colunas principais |
|---|---|
| `cadastros` | `id` uuid PK · `nome_enc` bytea · `email_enc` bytea · `email_bidx` char(64) UNIQUE · `email_mask` · `criado_em` · `status` |
| `links_gerados` | `id` uuid PK · `cliente_id` FK · `ramp_profile_id` FK · `chain` · `asset` · `token_contract` · `moeda_fiat` · `valor_fiat_centavos` int · `valor_fiat_unidades` int · `indice_hd` · `endereco_deposito` UNIQUE · `ramp_url` · `status` (`aguardando`/`pago`/`parcial`/`expirado`/`revogado`) · `expira_em` · `criado_em` |
| `cadastros_links` | `cliente_id` FK · `link_id` FK · PK composta · `criado_em` (relação N:N pedida) |
| `links_pagos` | `id` · `link_id` FK · `tx_hash` UNIQUE · `log_index` · `de_address` · `para_address` · `token` · `valor_base_units` bigint · `valor_recebido` numeric · `confirmacoes` · `bloco` · `status` · `detectado_em` · `confirmado_em` |
| `creditos_cliente` | `id` · `cliente_id` FK · `link_id` FK · `pagamento_id` FK · `valor_creditado` numeric · `moeda` · `status` (`pendente`/`liberado`/`revertido`) · `criado_em` |

**Apoio:**

| Tabela | Função |
|---|---|
| `ramp_profiles` | O "id do ramp": `id`, `label`, `chain`, `asset`, `token_contract`, `decimals`, `fiat_currency`, `base_url`, `param_style`, `host_api_key_enc` |
| `carteiras_frias` | `id`, `label`, `endereco` UNIQUE, `chain` — destino final |
| `movimentos_internos` | Sweeps: `id`, `link_id`, `de`, `para`, `valor`, `tx_hash`, `status`, `gas_usado` |
| `chain_cursors` | `chain`, `token_contract`, `ultimo_bloco`, `hash_bloco` — cursor do monitor + âncora de reorg |
| `hd_indices` | Alocação de índice por perfil (evita reuso de endereço) |
| `eventos_auditoria` | Log append-only: ator, ação, entidade, ip, ts, hash encadeado |

## 5. Fluxos

**A. Link (motor)**
`cadastro` → busca por email (blind index) → valida perfil Ramp + carteira fria → aloca índice HD (transacional, sem reuso) → deriva `m/44'/60'/0'/0/{i}` via xpub → monta URL Ramp → persiste → devolve `link_id` + URL.

**B. Detecção (worker, polling)**
Para cada perfil (chain, token): `eth_getLogs` filtrado por `topic0=Transfer` + `topic2 ∈ endereços derivados` (chunk 1000), a partir do cursor em `chain_cursors`. Em cada log: casa `to` com um link, checa símbolo/decimais, compara valor com tolerância (padrão 1%).

**C. Confirmação e crédito**
`confirmacoes >= N` (default 10, configurável) → marca `links_pagos.status=confirmado` → cria/atualiza `creditos_cliente` com **o valor efetivamente recebido** (nunca o esperado) → atualiza `links_gerados.status`.

**D. Sweep (worker)**
`pago` + saldo > 0 → *gas sponsor* envia POL → endereço assinado faz `transfer` ERC-20 → carteira fria → grava `movimentos_internos` → `links_gerados.status=movido`. Idempotência por `tx_hash`; retry com backoff; se o patrocinador sem saldo, o link fica `pago_sem_gas` e a UI alerta.

**E. Tolerância/divergência**
Valor recebido < esperado → `status=parcial` + evento de auditoria para revisão manual (conforme §6 do doc).

## 6. Segurança (foco do pedido)

**Chaves e segredos**
- Seed/xprv **nunca** no banco, na API ou nos logs. `scripts/init-wallet.ts` gera o mnemonic e mostra **uma única vez**; o que fica no servidor é o **xpub de conta** + keystore cifrado.
- `LocalSigner` guarda o xprv em keystore JSON cifrado (AES-256-GCM + scrypt, senha via `SIGNER_PASSPHRASE` do ambiente). Arquivo com `0600`.
- `RemoteSigner` (produção real): o core monta a tx e envia para Fireblocks/Gnosis por HTTP — a chave nunca toca o servidor.
- `xpub` é tratado como secret (expõe o histórico inteiro). Redigido em logs e respostas.
- Logs: `pino` com `redact` para `xpub`, `xprv`, `seed`, `passphrase`, `host_api_key`, `ramp_url`, `token`.

**PII (dados do cliente)**
- `nome` e `email` cifrados em repouso com AES-256-GCM; IV aleatório por registro; AAD = `id` do registro (impede trocar ciphertext entre linhas).
- Busca por email via **blind index** `HMAC-SHA256(index_key, email_normalizado)` — permite "buscar no bd" sem decifrar tudo e sem o índice virar dicionário reversível.
- Display padrão é mascarado (`jo***@ex***.com`); revelar é ação explícita + registro em `eventos_auditoria`.
- `index_key` e `data_key` são chaves distintas, ambas do ambiente, rotação documentada.

**API / front**
- Autenticação: `Authorization: Bearer` com token admin (comparação constant-time, hash no env). Rate limit por IP e por token.
- ID de link = 128 bits aleatórios; nunca sequencial. Endereço de depósito **nunca** é aceito do cliente — é sempre derivado no servidor.
- **Envenenamento de valor**: a URL Ramp carrega `fiatValue` e é editável pelo pagador. Mitigação: o crédito usa **só** o valor recebido on-chain; divergência vira `parcial` e alerta.
- `hostPaymentId=<link_id>` na URL para correlação (a Ramp pode ignorar).
- CSP + `X-Content-Type-Options` + `X-Frame-Options` nas páginas.
- Constraint `UNIQUE` em `endereco_deposito`, `tx_hash` e `email_bidx`; `advisory lock` do Postgres garante um único worker.

## 7. Front-end (2 páginas)

Vanilla HTML/CSS/JS, sem CDN, servidas pelo Fastify em `/cadastro.html` e `/cobranca.html`.

**1) Cadastro** — campos nome + email → `POST /api/cadastros` → confirmação com email mascarado. Validação client-side + server-side (zod, normalização de email).

**2) Geração de cobrança** —
- Busca de cliente: input email → autocomplete (`GET /api/cadastros?email=`) → seleciona o cadastro (mostra nome + email mascarado)
- Valor da cobrança (BRL) com conversão para unidades
- "Id do ramp": select das `ramp_profiles` + opção de cadastrar nova
- "Carteira final": select das `carteiras_frias` + endereço livre validado (EIP-55)
- → `POST /api/links` → exibe a URL com botão copiar, endereço de depósito, QR code (canvas local, sem CDN) e link de status
- Painel de status com polling em `GET /api/links/:id`: `aguardando → pago → movido`, mostrando valor pago, tx hash e crédito do cliente

## 8. Stack e comandos

`ethers@6.17` · `fastify@5.12` · `drizzle-orm@0.45` + `drizzle-kit` · `postgres@3.4` · `zod@4.6` · `pino@10` · `typescript@5.9` · `vitest@5` · `@fastify/static` · `@fastify/rate-limit`

```
docker compose up -d db
npm run dev            # servidor :4578
npm run worker         # monitor + sweeper
npm run migrate
npm run wallet:init    # gera xpub + keystore cifrado
npm test
```

## 9. Riscos

| Risco | Mitigação |
|---|---|
| Pagador edita o valor na URL | Crédito pelo valor on-chain + status `parcial` |
| Sponsor sem POL | Status `pago_sem_gas` + alerta + retry |
| Reorg na Polygon | Cursor com hash de âncora + N confirmações |
| Endereço derivado sem gas | Padrão gas sponsor |
| Duplicidade de pagamento | `UNIQUE(tx_hash)` + upsert por log_index |
| Perda da seed | Seed gerada e exibida 1×, fora do repo; xpub no servidor |

## 10. Ordem de execução

1. Scaffold + Docker Compose + config zod + health
2. Schema Drizzle + migrations + seeds (`ramp_profiles`, `carteiras_frias`)
3. Core: crypto (AES/HMAC), HD (xpub + validação de depth + índice), Ramp URL builder
4. Ports + adapters de DB
5. Sinais/estados + `links.create` + API
6. Worker: monitor (getLogs, cursor, confirmações) + crédito
7. Worker: sweeper + gas sponsor
8. Front-end: 2 páginas
9. Testes: derivação xpub vs xprv (vetor conhecido), detecção, sweep, integração DB
10. README com setup, threat model e operação

---

## Andamento da execução

O plano acima foi executado integralmente. Registro do que mudou durante a
implementação (o plano original permanece intacto acima, como combinado):

**Confirmado como estava previsto**
- Porta do servidor: **4578** (3000 estava ocupada). Postgres em 5432.
- xpub de conta (`m/44'/60'/0'`) + caminho relativo `0/{index}` — validado com
  teste que compara xpub vs xprv.
- Gas sponsor para endereços derivados sem saldo nativo.
- Endereço do USDC corrigido (`...70d8cC03d5c3359`).

**Deltas acrescentados**
- Tabela extra `cadastros_prefixos`: tokens de blind index por prefixo, para
  busca parcial sem guardar o email em claro (HMAC não é "prefix-searchable").
- Migration `0001_check_constraints.sql`: 25 CHECK constraints de integridade
  (o drizzle desta versão não emite `varchar(n)`).
- `ramp_profiles.taxa_token_por_fiat_base_units`: taxa de referência (snapshot
  no momento do link) que permite classificar pagamento parcial. Sem ela, o
  motor credita só o valor recebido, sem poder marcar divergência.
- Varredura adaptativa de blocos: o RPC público recusa faixas grandes, então o
  monitor descobre o maior span aceito e varre o intervalo inteiro em sub-faixas
  (o cursor só avança depois de cobrir tudo).
- `scripts/verify-monitor.ts`: verificação end-to-end do monitor contra
  transferências USDC reais da Polygon, sem gastar e sem assinar nada.

**Bugs encontrados pelos testes durante a execução**
- Tolerância de valor dividia por 10.000 em vez de 1.000.000 (aceitava 10% de
  diferença em vez de 1%).
- `unitsToCents` multiplicava por 100 indevidamente — a Ramp usa unidades
  mínimas (ISO-4217), então `15000` = R$ 150,00 e não R$ 15.000,00.
- O cursor do monitor avançava além do que o RPC efetivamente devolveu,
  podendo pular blocos.

**Estado ao final**
- 60 testes passando, typecheck limpo, build limpo.
- Monitor validado on-chain: detectou 4 transferências USDC reais, confirmou
  3 e gerou os créditos correspondentes.
- Servidor no ar em `http://localhost:4578` (telas em `/cadastro.html` e
  `/cobranca.html`).
