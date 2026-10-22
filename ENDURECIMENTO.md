# Endurecimento do Motor Cripto

> Plano de ataque às classes de bugs reveladas pela primeira entrega e
> às limitações registradas no `README.md`. Frentes ordenadas por risco
> de dano (A → C → D → E → B → F).

## 1. Contexto

Os 3 bugs pegados pelos testes não são 3 erros isolados — são 3 **sintomas
de 3 classes**:

| Bug corrigido | Classe revelada | Falta hoje |
|---|---|---|
| Tolerância dividia por 10.000 | Matemática de dinheiro sem invariantes | Nenhum teste de propriedade; regra implícita em código |
| `unitsToCents` × 100 | Semântica de unidades não é um contrato | Docstring só; nada impede o próximo erro |
| Cursor avançava além do RPC | Máquina de estados sem contrato de "consumido" | Nenhum teste que fixe o watermark |

E as limitações do README são **lacunas de modelo**, não de implementação:
reorg sem estado, rotação sem `kid`, sweep sem destino persistido, QR
sem dono.

## 2. Auditoria do código — 9 problemas adicionais encontrados

Todos verificados no código, não suspicions:

| # | Problema | Gravidade | Onde |
|---|---|---|---|
| 1 | **A carteira fria escolhida no formulário é ignorada.** Não é persistida no link; o sweeper escolhe a *primeira* da chain. A UI mente ao operador | **CRÍTICO** | `link-service.ts`, `sweeper.ts:resolveColdWallet` |
| 2 | **`hash_bloco` nunca é lido.** O cursor grava o hash e ninguém compara → reorg silencioso | ALTO | `monitor.ts:153` |
| 3 | **Nunca se varre até `finalized`.** Processa blocos não-finalizados → reorg desfaz pagamento já creditado | ALTO | `monitor.ts:105` |
| 4 | **`'revertido'` existe no enum mas nada nunca escreve.** Caminho de reversão inexistente | ALTO | `domain/types.ts:21` |
| 5 | **Cadeia de auditoria pode bifurcar.** `ORDER BY criado_em DESC LIMIT 1` sem lock: API e worker concorrentes leem o mesmo antecessor | ALTO | `repositories.ts:record()` |
| 6 | **`updateStatus` sem tabela de transições.** Qualquer estado → qualquer estado | MÉDIO | `repositories.ts:398` |
| 7 | **Envelope de cifragem sem `kid`.** Rotação de chave impossível | MÉDIO | `crypto/cipher.ts:VERSION` |
| 8 | **Blind index com chave única.** Rotacionar exigiria reindexar tudo sem caminho | MÉDIO | `crypto/cipher.ts:BlindIndex` |
| 9 | **Links `'movido'` nunca são reconciliados.** Sweep reorgado deixa fundos presos para sempre | MÉDIO | `sweeper.ts:23` |

Bônus semântico: o sweeper marca **`'pago_sem_gas'` quando o saldo é zero** —
"não há o que mover" vira "sem gas". Diagnóstico errado.

## 3. Decisões

| Decisão | Escolha |
|---|---|
| Reorg | `finalized` como teto **+** âncora de hash com rollback (defesa em profundidade) |
| Rotação | Envelope v2 com `kid` + keyring + CLI `rotate-keys` com dry-run |
| QR | Sem CDN — geração **server-side** (pacote `qrcode`), SVG na resposta |

## 4. Frentes

### Frente A — Correções de corretude (bugs vivos)

- **A1**: Persistir destino: `carteira_fria_id` (FK) + `carteira_fria_endereco`
  (snapshot) em `links_gerados`. `LinkService` grava; sweeper **lê o link** e
  nunca consulta a lista. Backfill das linhas existentes.
- **A2**: Corrigir o diagnóstico errado: saldo zero mantém `'pago'` + nota;
  `'pago_sem_gas'` só quando falta gas de fato.
- **A3**: Auditoria sem bifurcação: `pg_advisory_xact_lock` no `record()`,
  ordenação determinística `(criado_em, id)`.
- **A4**: Máquina de estados: `LINK_TRANSITIONS` no domain + `LinkStateMachine
  .transition(id, to, reason)` que valida, persiste e audita. Repo continua burro.
- **A5**: Reconciliação: links `'movido'`/`'expirado'`/`'revogado'` com saldo > 0
  voltam para sweep (cobre sweep reorgado).

**Tabela de transições:**
```
aguardando  → pago | parcial | pago_sem_gas | expirado | revogado
pago        → parcial | movido | pago_sem_gas | expirado | revogado
parcial     → pago | movido | pago_sem_gas | expirado | revogado
pago_sem_gas→ pago | parcial | movido | expirado | revogado
movido      → pago | parcial            (só por reorg/reconciliação)
expirado    → pago | parcial | revogado (pagamento fora do prazo)
revogado    → pago | parcial            (dinheiro chegou mesmo assim)
```
**Nunca se recusa dinheiro que chegou.** Pagamento tardio ou em link
revogado é creditado e sinalizado para revisão.

### Frente B — Blindar as classes (testes e invariantes)

- **B1**: **Property-based tests** com `fast-check` no módulo de dinheiro.
- **B2**: Contrato de unidades explícito: tabela `UNITS` + asserts.
- **B3**: Teste de contrato do cursor: "nunca ultrapassa o bloco coberto".
- **B4**: Teste da tabela de transições: legal passa, ilegal lança.

### Frente C — Reorg (`finalized` + âncora)

- **C1**: `MONITOR_BLOCK_TAG=finalized|latest` (default `finalized`).
  `eth_getLogs` aceita a tag (`toBlock:"finalized"` verificado).
- **C2**: Âncoras esparsas: `chain_anchors(chain, token_contract, bloco, hash_bloco)`.
- **C3**: Verificação: a cada ciclo, compara o hash de `ultimo_bloco` com o
  âncora. Divergência → busca o ancestral comum → **rewind**.
- **C4**: Revogação: pagamentos com `bloco > ancestral` → `'revertido'`;
  créditos correspondentes → `'revertido'`; link volta a `'aguardando'`.
- **C5**: `movimentos_internos` ganha `chain` + `bloco`.
- **C6**: Teste de reorg com chain simulada (fake provider).

### Frente D — Sweeper robusto e multi-chain

- **D1**: Destino persistido (A1).
- **D2**: **Dust nativo**: após o transfer ERC-20, devolve o POL restante
  para a carteira fria.
- **D3**: **Não duplicar tx**: checa `getTransactionCount(addr,'pending')` antes.
- **D4**: **Idempotência**: `UNIQUE(link_id, nonce)` em `movimentos_internos`.
- **D5**: Gas sponsor: verificar saldo antes de patrocinar.
- **D6**: Lote por (chain, token): agrupa para não reabrir provider a cada link.

### Frente E — Rotação de chaves

- **E1**: **Envelope v2**: `[version=2][kid(1)][iv(12)][tag(16)][ct]`.
  `DataCipher` v2 **lê v1 e v2**; toda escrita nova usa v2 + `kid` corrente.
- **E2**: **Keyring**: `KEYRING` no `.env` = JSON com chaves + `DATA_ACTIVE_KID`.
- **E3**: **Blind index versionado**: `email_bidx` guarda sempre o token
  ativo (canonico e unico); durante a rotacao o anterior fica em
  `email_bidx_anterior`. Prefixos usam PK `(cliente_id, prefix_bidx)` para
  que dois clientes com o mesmo prefixo nao se sobrescrevam.
- **E4**: **CLI `npm run rotate-keys`**: `--dry-run`, lotes transacionais,
  verificação pós-rotação, modo `--blind-index`.
- **E5**: Testes: round-trip v1↔v2, `kid` desconhecido → erro.

### Frente F — QR e observabilidade

- **F1**: QR **server-side** com `qrcode`: `POST /api/links` devolve
  `qrcodeSvg`; `GET /api/links/:id/qrcode.svg` também.
- **F2**: **`GET /api/alerts`**: lista unificada — parcial, pago_sem_gas,
  expirado sem pagamento, reorg detectado, sponsor com saldo baixo, erros de RPC.
- **F3**: Badges na UI + `ALERT_WEBHOOK_URL` opcional.

## 5. Ordem de execução

Ordenado por **risco de dano**:

| Ordem | Frente | Por quê |
|---|---|---|
| 1º | **A** | O bug #1 é crítico e está em produção: toda cobrança pode estar indo para a carteira errada |
| 2º | **C** | Reorg pode perder dinheiro do cliente |
| 3º | **D** | Sweeper move o dinheiro; precisa de destino correto, idempotência e dust |
| 4º | **E** | Rotação é preventiva, mas o envelope v2 muda o formato |
| 5º | **B** | Testes de propriedade blindam tudo; entra depois |
| 6º | **F** | QR e alertas: valor de UX |

## 6. Verificação de cada frente

- `npm run typecheck` + `npm test` (sem regressão) + `npm run build`
- **A1**: link aponta para a carteira escolhida mesmo havendo outra da mesma chain
- **A3**: 20 inserts paralelos → cadeia de auditoria sem bifurcação
- **C6**: reorg com chain simulada
- **E4**: `--dry-run` + execução + verificação pós-rotação em cópia do banco
- **F1**: SVG com `Content-Type: image/svg+xml`, sem `<script>`
- **Regressão real**: `npm run verify:monitor` continua detectando transferência real da Polygon

## 7. Esforço

| Frente | Esforço |
|---|---|
| A (5 correções) | 1–1,5 dia |
| B (property tests + contrato) | 0,5–1 dia |
| C (reorg) | 1,5–2 dias |
| D (sweeper) | 1 dia |
| E (rotação) | 1,5 dia |
| F (QR + alertas) | 0,5 dia |
| **Total** | **~6–8 dias** |

Cada frente vira um commit separado (revisável e revertível).

## 8. Fora do escopo (propositalmente)

- **Gas sponsor como contrato (ERC-4337/paymaster)**: o padrão atual resolve
- **Fallback automático de RPC**: hoje o `RPC_URL_POLYGON` é fixo
- **Preço on-chain (Chainlink)**: a taxa de referência é configurada manualmente
- **Rollback de reorg em cadeias sem `finalized`**: só Polygon está no escopo

---

## Resultado da execução

### Fase 1 — frentes A a F

Todas as 6 frentes foram executadas, na ordem A → C → D → E → B → F.
Um commit por frente, cada um revisável e revertível isoladamente.

| Frente | Commit | Entregue |
|---|---|---|
| A | `5b8f35e` | destino do sweep persistido, diagnóstico correto, auditoria sem bifurcação, máquina de estados, reconciliação |
| C | `fd3232b` | teto `finalized`, âncoras de hash, rollback, revogação de crédito, sweep reorgado |
| D | `dd1ff64` | dust nativo, sem tx duplicada, idempotência `(link, nonce)`, sponsor sem saldo |
| E | `fde99c5` | envelope v2 com `kid`, keyring, blind index versionado, CLI de rotação |
| B | `7ac706c` | 25 propriedades de dinheiro + contrato do cursor |
| F | `dc1edd4` | QR server-side, `/api/alerts`, badge e painel na tela |

**Testes: 60 → 164.**

### Fase 2 — endurecimento adicional (blocos 0 a 4)

Depois da primeira entrega, a revisão dos caminhos de falha do sweep, da
assinatura e dos índices de e-mail gerou mais cinco blocos. O commit
`b87d852` cobre os blocos 0–3; o bloco 4 entra no commit deste documento.

| Bloco | Entregue |
|---|---|
| 0–2 | recuperação de sweep após crash, `kind`/`rawTransaction`, idempotência `(link, kind, nonce)`, dust, reorg até `finalized` + âncoras, crédito revertido/restaurado, piso de `MONITOR_START_BLOCK` |
| 3 | PSBT ponta a ponta (`unsigned_transaction`, `POST /api/movimentos/:id/raw`), validação da tx assinada contra a unsigned, `LocalSigner` confrontando seed x xpub, `--account-index` no `init-wallet`, `fromAccountXprv` só aceitando conta |
| 4 | `email_bidx` sempre canônico e único, `email_bidx_anterior` na rotação, PK de prefixos por `(cliente_id, prefix_bidx)`, `reindex:prefixes`, e-mail duplicado como 409 |

Migrações novas: `0008_sweep_kind_raw`, `0009_psbt_unsigned` e
`0010_email_index_canonical` (aplicada no banco de desenvolvimento).

**Testes: 164 → 230 unitários + 9 de integração com Postgres real.**

### Bugs reais encontrados durante a execução

Não foram só as correções planejadas; testes e validações ao vivo revelaram
mais problemas, todos corrigidos:

| Achado | Onde | Gravidade |
|---|---|---|
| Sweep pendente sem `raw_transaction` ficava preso após crash antes do broadcast, sem caminho de recuperação | `sweeper.ts` | ALTO |
| PSBT preparava a unsigned mas não expunha submissão do raw assinado; a validação da tx assinada não comparava todos os campos | `sweeper.ts`, `signer.ts` | ALTO |
| `LocalSigner` não confrontava a seed com o `HD_XPUB`; `init-wallet` ignorava `--account-index` e `fromAccountXprv` aceitava xprv que não era de conta | `signer/`, `scripts/init-wallet.ts` | MÉDIO |
| O harness de teste derivava `accountNode.deriveChild(index)` em vez de `0/index`, assinando um endereço diferente do esperado | `tests/` | teste |
| PK de `cadastros_prefixos` era só `prefix_bidx`; `onConflictDoNothing()` descartava o segundo cliente com o mesmo prefixo | migration 0000 / `repositories.ts` | ALTO |
| Unique existia só em `email_bidx`; após a rotação o token ativo ia para `email_bidx_v2` sem unique, permitindo e-mail duplicado | migration 0005 / `customer-service.ts` | ALTO |
| E-mail duplicado virava 500 em vez de erro de domínio | `customer-service.ts` / `app.ts` | MÉDIO |
| Prefixos já perdidos pela colisão antiga não eram recuperáveis por SQL; passaram a ter reconstrução a partir do e-mail decifrado | `scripts/reindex-prefixes.ts` | MÉDIO |

O achado da **tolerância** só apareceu porque a propriedade "nunca aceita
pagamento dobrado" foi escrita. Nenhum caso fixo teria pego. O mesmo vale
para a colisão de prefixos: só apareceu ao testar dois clientes com o mesmo
início de e-mail.

### Como cada problema foi validado

Nenhuma entrega foi aceita só por "os testes passam":

- **A1** — escolhi a carteira B com a A existente e verifiquei que o link
  aponta para B no banco (antes o sweeper pegaria a A)
- **A3** — cadeia de auditoria com `pg_advisory_xact_lock`
- **C** — contra a Polygon real: corrompi o hash do cursor e o detector
  percebeu o reorg, voltou 2 blocos até o ancestral comum
- **E** — rotação completa no Postgres: cadastra com k1, rotaciona, busca
  funciona com a chave nova **e** com a antiga, e para de funcionar quando
  a chave nova sai do keyring
- **F** — link criado pela API volta com QR de 5,3 KB, sem `<script>`
- **Bloco 3** — PSBT assinado manualmente, raw submetido pela API e
  broadcast; unsigned divergente é rejeitada campo a campo
- **Bloco 4** — dois clientes com o mesmo prefixo aparecem no autocomplete;
  duplicado no índice canônico falha com 409 durante e depois da rotação;
  `reindex:prefixes --dry-run` roda sobre o banco real
- **Regressão** — `verify:monitor` continua detectando transferência USDC
  real da Polygon (3 execuções consecutivas sem falha)

Verificação final: `npm run typecheck`, `npm test` (230), `npm run
test:integration` (9), `npm run build` e `npm run migrate` verdes.

### Pendências que continuam abertas

Nada abaixo foi escopo do endurecimento; ficam registradas:

- **`GAS_SPONSOR_PRIVATE_KEY` não configurada** — sem ela nenhum valor
  recebido pode ser movido. O alerta `/api/alerts` reporta como crítico.
- **Reorg em cadeia sem `finalized`** — só Polygon está coberto.
- **Rotação do keystore do signer** — o envelope v2 cobre a PII, mas o
  `data/keystore.json` ainda depende de recifrar à mão.
- **Alerta de saldo baixo do patrocinador** — o alerta existe para
  "ausente", mas a verificação de saldo exigiria chamar o provider; ficou
  como `info` estático.
- **Dust nativo no modo PSBT** — `sweepNativeDust` ignora a assinatura
  manual; o POL restante fica no endereço derivado e o link vai para
  `movido`. Fora do escopo desta rodada.
- **Reindexação de bases existentes** — `npm run reindex:prefixes` precisa
  ser executado nas bases que já sofreram a colisão de prefixos; a migração
  corrige o schema, não os registros perdidos.
