# Motor Cripto

Motor reutilizavel de pagamentos on-chain para **vendedores sem conta business na Ramp**.

O fluxo completo:

```
cliente paga o link da Ramp
   -> stablecoin cai num endereco HD exclusivo daquele link
   -> motor detecta a entrada lendo a blockchain (substitui o webhook da Ramp)
   -> credito do cliente registrado no banco
   -> valor transferido automaticamente para a carteira fria
```

O nucleo (`src/core`) nao depende de HTTP, framework nem banco concreto: ele recebe
**ports** (interfaces) por injecao. Qualquer aplicacao pode importar o motor e
usar `createMotor()` para ter cobranca + confirmacao on-chain + sweep.

---

## Sumario

- [Arquitetura](#arquitetura)
- [Setup](#setup)
- [Uso](#uso)
- [Modelo de dados](#modelo-de-dados)
- [Seguranca](#seguranca)
- [API HTTP](#api-http)
- [Operacao](#operacao)
- [Decisoes e limitacoes](#decisoes-e-limitacoes)

---

## Arquitetura

```
src/
├── core/                    O MOTOR (sem framework, sem driver de banco)
│   ├── index.ts             createMotor(config) -> { customers, links, monitor, sweeper }
│   ├── config.ts            validacao de ambiente (zod), falha no boot
│   ├── domain/              tipos, estados, aritmetica de dinheiro
│   ├── hd/                  derivacao xpub + keystore cifrado
│   ├── ramp/                construtor de URL (estilos legacy e unified)
│   ├── chain/               monitor, sweeper, gas sponsor, ERC-20
│   ├── signer/              LocalSigner | RemoteSigner | PsbtSigner
│   ├── crypto/              AES-256-GCM, blind index (HMAC), mascaras
│   └── ports/               interfaces de repositorio
├── adapters/
│   ├── db/                  Drizzle + Postgres (implementa os ports)
│   └── http/                Fastify (rotas finas sobre o core)
├── worker/                  processo monitor + sweeper
└── server.ts                boot do HTTP

web/                         as duas telas (vanilla, sem CDN)
db/migrations/               migrations (drizzle-kit + SQL manual)
scripts/                     init-wallet, seed, verify-monitor
```

**Regra do core:** `src/core` nao importa `fastify`, `drizzle-orm` nem `postgres`.
Ele so conhece `ethers` (ECDSA/ABI) e `zod`.

---

## Setup

### Pre-requisitos

- Node.js >= 22
- Docker (para o Postgres)
- Uma chave JSON-RPC de Polygon (a publica do publicnode funciona, mas e limitada)

### 1. Infra

```bash
docker compose up -d db
```

### 2. Dependencias e configuracao

```bash
npm install
cp .env.example .env
```

Gere os segredos:

```bash
# chaves de cifragem e blind index (32 bytes cada)
openssl rand -base64 32   # DATA_ENCRYPTION_KEY
openssl rand -base64 32   # DATA_INDEX_KEY
openssl rand -hex 32      # ADMIN_TOKEN
```

### 3. HD Wallet

```bash
npm run wallet:init -- --passphrase "sua-senha-forte" --show-seed
```

Isso gera `data/keystore.json` (cifrado, permissao 0600) e imprime:

- o **xpub de conta** (`m/44'/60'/0'`) -> va em `HD_XPUB` no `.env`
- a **seed** (apenas com `--show-seed`) -> **guarde offline agora**. Perder a seed
  significa perder os fundos que forem enviados para os enderecos derivados.

### 4. Banco

```bash
npm run migrate
npm run seed
```

O seed cria os perfis de integracao Ramp (`Polygon USDC`, `Polygon USDT0`) e a
carteira fria (se `COLD_WALLET_ADDRESS` estiver definido no `.env`).

### 5. Subir

```bash
npm run dev      # API + telas em http://localhost:4578
npm run worker   # monitor on-chain + sweep (processo separado)
```

O worker usa um **advisory lock** do Postgres: apenas uma instancia roda por banco.

---

## Uso

### Telas

| Pagina | Caminho | O que faz |
|---|---|---|
| Cadastro | `/cadastro.html` | nome + email do cliente |
| Gerar cobranca | `/cobranca.html` | busca cliente, valor, id do ramp, carteira final -> gera o link |

Ambas pedem o `ADMIN_TOKEN` na barra superior (fica em `sessionStorage`).

### Fluxo de programacao

```ts
import { createMotor, HdWallet, LocalSigner } from './src/core/index.js';

const motor = createMotor({ repos, hdWallet, signer, providerFactory, gasSponsor, logger, dataKey, indexKey, ttlHours: 72 });

const customer = await motor.customers.create({ nome: 'Maria', email: 'maria@example.com' });
const link = await motor.links.create({
  clienteId: customer.id,
  amountCents: 15_000,
  rampProfileId: profile.id,
  coldWalletAddress: '0x...',
});
// link.rampUrl -> enviar ao cliente
```

---

## Modelo de dados

| Tabela | Papel |
|---|---|
| `cadastros` | clientes: nome e email **cifrados**, blind index do email, mascaras |
| `cadastros_prefixos` | tokens de blind index por prefixo (busca parcial sem texto claro) |
| `links_gerados` | um link por cobranca: valor, perfil Ramp, indice HD, endereco derivado, URL |
| `cadastros_links` | relacao N:N cliente <-> link |
| `links_pagos` | um registro por transferencia on-chain detectada (tx_hash + log_index unicos) |
| `creditos_cliente` | credito do cliente, com o valor **efetivamente recebido** |
| `ramp_profiles` | o "id do ramp": chain, asset, contrato, moeda, estilo de URL, taxa de referencia |
| `carteiras_frias` | carteiras de destino final |
| `movimentos_internos` | sweeps (endereco derivado -> carteira fria) |
| `chain_cursors` | cursor do monitor por (chain, token) |
| `hd_indices` | indices HD alocados (nunca reutilizados) |
| `eventos_auditoria` | log append-only com hash encadeado |

### Convencao de dinheiro

- fiat: **centavos** (inteiro). `15000` = R$ 150,00
- token: **base units** (`bigint`). `27000000` = 27 USDC (6 decimais)
- nunca float

`valorFiatUnidades` usa **unidades minimas** ISO-4217, que e o que a Ramp espera
no parametro `inAssetValue` (`"10.00" EUR` -> `"1000"`).

---

## Seguranca

### Chaves

| Segredo | Onde fica | Observacao |
|---|---|---|
| seed / xprv | `data/keystore.json` cifrado (scrypt + AES-256-GCM, 0600) | gerada 1x, backup offline |
| xpub de conta | `.env` (`HD_XPUB`) | **e segredo**: expoe todos os enderecos derivados e todo o historico |
| `ADMIN_TOKEN` | `.env` | Bearer token da API |
| `DATA_ENCRYPTION_KEY` | `.env` | AES-256-GCM da PII |
| `DATA_INDEX_KEY` | `.env` | HMAC do blind index (chave separada) |

O servidor de derivacao so precisa do **xpub**. A chave privada so e carregada
pelo `LocalSigner`. Para producao, use `SIGNER_MODE=remote` (a transacao vai
para um servico externo assinar) ou `psbt` (assinatura manual em hardware wallet).

### PII

- `nome` e `email`: AES-256-GCM, IV aleatorio por registro, **AAD = id do registro**
  (trocar o ciphertext entre linhas quebra a autenticacao).
- busca por email: **blind index** `HMAC-SHA256(index_key, email_normalizado)`.
  O banco nao guarda o email em texto puro e o indice nao e reversivel.
- busca por prefixo: tokens de blind index por prefixo (3..32 chars).
  Trade-off conhecido: o **tamanho** do email e a frequencia de prefixos ficam
  expostos no indice. A PK e `(cliente_id, prefix_bidx)`, entao dois clientes
  com o mesmo prefixo nao se sobrescrevem.
- `email_bidx` guarda sempre o indice **ativo** (unique); durante a rotacao o
  token anterior fica em `email_bidx_anterior`. Para reconstruir a tabela de
  prefixos apos uma rotacao, use `npm run reindex:prefixes` (aceita `--dry-run`).
- a UI mostra mascarado por padrao (`m***@e***.com`).

### API

- `Authorization: Bearer` com comparacao em tempo constante
- rate limit por IP (120/min)
- CSP com `script-src 'self'` (sem CDN, sem script inline)
- endereco de deposito **nunca** vem do cliente: e sempre derivado no servidor
- ids de link sao aleatorios (128 bits), nunca sequenciais
- log de auditoria com hash encadeado

### Risco residual conhecido

**O pagador pode editar o valor na URL da Ramp.** A URL carrega `fiatValue` e
e editavel por quem paga. Mitigacao implementada: o credito usa **apenas** o
valor recebido on-chain; divergencia com o esperado marca o link como `parcial`
e o evento vai para a auditoria. A taxa de referencia (`taxa_token_por_fiat_base_units`
no perfil Ramp) e um snapshot no momento da criacao do link — atualize-a quando
o cambio USD/BRL mudar.

---

## API HTTP

Base: `http://localhost:4578`. Todas as rotas `/api/*` exigem `Authorization: Bearer $ADMIN_TOKEN`
(exceto `/api/health`).

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/motor/status` | estado do motor (perfis, carteiras, signer) |
| POST | `/api/cadastros` | `{ nome, email }` |
| GET | `/api/cadastros?email=` | busca exata por email |
| GET | `/api/cadastros?q=` | busca por prefixo (autocomplete) |
| GET | `/api/cadastros/:id` | detalhe do cliente |
| POST | `/api/links` | `{ email \| clienteId, valor, rampProfileId, coldWalletId \| coldWalletAddress }` |
| GET | `/api/links/:id` | link + pagamentos + movimentos + creditos (inclui unsigned PSBT) |
| POST | `/api/movimentos/:id/raw` | PSBT: submete o raw assinado (somente admin) |
| GET | `/api/links?clienteId=` | links do cliente |
| GET | `/api/creditos?clienteId=` | creditos do cliente |
| GET/POST | `/api/ramp-profiles` | perfis de integracao Ramp (o "id do ramp") |
| GET/POST | `/api/carteiras-frias` | carteiras de destino final |
| GET | `/api/auditoria` | log de auditoria |

Exemplo:

```bash
curl -X POST http://localhost:4578/api/links \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"maria@example.com","valor":"150,00","rampProfileId":"<uuid>",
       "coldWalletAddress":"0x..."}'
```

---

## Operacao

### Verificacao do monitor (end-to-end, sem gastar)

```bash
npm run verify:monitor
```

O script encontra uma transferencia de USDC **real** na Polygon, cadastra um link
apontando para o endereco receptor dela, roda o monitor e mostra se o pagamento foi
detectado, confirmado e creditado. Limpa o que criou.

### Monitor

Para cada perfil Ramp (chain, token), o worker:

1. le o cursor em `chain_cursors`
2. busca `Transfer` com `topic2` = enderecos derivados (topic de 32 bytes, com padding)
3. se o RPC recusar a faixa de blocos, descobre o maior span aceito e varre o
   intervalo inteiro em sub-faixas — **nenhum bloco e pulado**
4. registra em `links_pagos` (idempotente por `tx_hash` + `log_index`)
5. quando `confirmacoes >= CONFIRMATIONS_REQUIRED`, confirma e credita o cliente

### Sweep

Enderecos HD nascem com **saldo nativo zero**, e um `transfer` ERC-20 exige gas.
Por isso o motor usa o padrao **gas sponsor**:

1. a carteira patrocinadora (`GAS_SPONSOR_PRIVATE_KEY`) envia ~0,5 POL para o
   endereco derivado
2. o endereco derivado assina o `transfer` do token para a carteira fria
3. o tx e transmitido e acompanhado; o link vira `movido`

Sem patrocinador configurado, o link fica `pago_sem_gas` e a UI avisa.

Custo aproximado por link na Polygon: ~0,01 USD de gas + ~0,05 USD de gas do
patrocinador.

### Estados do link

`aguardando` -> `pago` | `parcial` | `pago_sem_gas` -> `movido`
(`expirado`, `revogado` sao terminais manuais)

---

## Decisoes e limitacoes

### O xpub de conta, nao o master

`m/44'/60'/0'/0/{i}` tem tres passos **hardened** (`44'`, `60'`, `0'`), que um xpub
nao consegue derivar. O motor usa o xpub **de conta** (`m/44'/60'/0'`, depth 3) e
deriva o caminho **relativo** `0/{i}`. O `HdWallet` valida o depth e recusa com
mensagem explicativa. Ha teste garantindo que xpub e xprv produzem os mesmos
enderecos.

### Endereco do USDC

O `projetoo.md` traz `0x3c499c542cEF5E3811e1192ce70d5cC03d5c3359` (com `d5c`);
o endereco correto do USDC nativo na Polygon e
`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (com `d8c`). O USDT0 e
`0xc2132D05D31c914a87C6611C10748AEb04B58e8F`. Ambos com 6 decimais.

### RPC

`polygon-rpc.com` passou a exigir API key. O padrao aqui e
`polygon-bor-rpc.publicnode.com`, que e **limitado** (faixa de blocos e volume de
resultados). Para producao, use Alchemy/Infura/QuickNode em `RPC_URL_POLYGON`.

### Ramp

- Estilo `legacy` (padrao): `https://buy.ramp.network/?userAddress=..&asset=USDC&network=polygon&fiatValue=150.00&fiatCurrency=BRL`
- Estilo `unified`: `https://app.rampnetwork.com/?defaultFlow=ONRAMP&inAsset=BRL&inAssetValue=15000&enabledCryptoAssets=POLYGON_USDC&userAddress=..`
- A Ramp converte parametros legacy para o formato novo automaticamente.
- `hostPaymentId` carrega um id de correlacao (a Ramp pode ignorar).

### Ainda nao implementado

- **QR code** do link (as telas mostram a URL com botao de copiar)
- **Reorg handling**: o cursor guarda o hash do bloco, mas nao ha rollback
  automatico se um bloco for reescrito. Com `CONFIRMATIONS_REQUIRED=10` o risco e
  baixo; para producao, implemente o rollback a partir do hash ancorado.
- **Multi-chain no sweeper**: o sweep usa a carteira fria da mesma chain do link.
- **Rotacao de chaves** de cifragem (as chaves sao separadas e versionaveis, mas
  a re-cifragem em lote nao foi implementada).

---

## Comandos

| Comando | Descricao |
|---|---|
| `npm run dev` | servidor em modo watch (porta 4578) |
| `npm run build` / `npm start` | build e execucao em producao |
| `npm run worker` | monitor + sweeper |
| `npm run migrate` | aplica migrations |
| `npm run seed` | perfis Ramp + carteira fria |
| `npm run wallet:init` | gera a HD Wallet |
| `npm run rotate:keys` | re-cifra PII e rotaciona os blind indexes |
| `npm run reindex:prefixes` | reconstroi os prefixos de busca (`--dry-run`) |
| `npm run verify:monitor` | verificacao end-to-end do monitor |
| `npm test` | testes (vitest) |
| `npm run typecheck` | verificacao de tipos |

O plano completo do projeto esta em [`PLANO.md`](./PLANO.md).
