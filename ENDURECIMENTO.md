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
- **E3**: **Blind index versionado**: `cadastros.email_bidx_v2` +
  `cadastros_prefixos` ganha `key_id`.
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
