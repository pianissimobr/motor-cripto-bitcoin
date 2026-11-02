# Etapas PIX -> USDC na Base

Fluxo paralelo ao Bitcoin: receber PIX, converter para USDC na Base via
Lunium e liquidar na carteira da loja pelo `PayoutService`.

## Decisoes fechadas

- Ativo de destino: **USDC nativo na Base**.
- Liquidação: **Opção A** — Lunium entrega USDC na treasury quente da
  plataforma; o motor credita a loja no ledger e o `PayoutService` envia para a
  carteira allowlisted da loja.
- Spread próprio: **não no MVP**. A receita da plataforma é a comissão de
  parceiro configurada na chave Lunium.
- CPF/CNPJ do pagador: **efêmero**. Não persistir em texto claro; usar apenas em
  memória na criação e, se necessário, guardar hash/últimos dígitos.
- PIX de saída (USDC -> PIX) e custódia BRL: fora do escopo.
- Valores: BRL em centavos inteiros; USDC em unidades menores com 6 casas.

## Arquitetura

```text
Checkout/App
  -> POST /v1/pix-charges
  -> Lunium POST /cashin/charge
       destino=cripto, asset=usdc, chain=base,
       payout_address=<treasury USDC Base>
  <- qr_copypaste, qr_image_url, expires_at

Lunium
  -> POST /webhooks/lunium (HMAC)
  -> inbox durável
  -> worker confirma GET /cashin/{cashin_id}/status
  -> ledger: débito treasury:usdc / crédito merchant:<id>:usdc_available
  -> PayoutService envia USDC para carteira allowlisted da loja
```

## Status

### Local (`pix_charges.status`)

```text
criando | pendente | pago | liquidado | expirado | reembolsado | falhou | incerto | manual
```

### Lunium

```text
status: pending | delayed | under_review | paid | expired | refunded | failed
settlement_status: pending | sending | entregando | sent | incerto | failed
```

### Mapeamento

| Lunium | Local | Ação |
|---|---|---|
| `pending` | `pendente` | aguardar |
| `delayed` / `held` | `pendente` | exibir retenção, não creditar |
| `paid` + settlement `pending/sending/entregando` | `pago` | aguardar entrega |
| `paid` + settlement `sent` | `liquidado` | creditar ledger e criar payout |
| `expired` | `expirado` | encerrar |
| `refunded` | `reembolsado` | não creditar; se já liquidado, manual |
| `failed` / `settlement_failed` | `falhou` | alertar |
| settlement `incerto` | `incerto` | conciliar; não reenviar |

## Etapas

### Etapa 1 — Contrato e sandbox Lunium

- [ ] Criar chave `lun_test_` via `POST /keys/sandbox`.
- [ ] Confirmar `sandbox=true` em `GET /keys/me`.
- [ ] Confirmar rota `usdc` + `base` em `GET /cashin/catalog`.
- [ ] Criar cobrança de R$ 25,00 com `destino: "cripto"`.
- [ ] Simular pagamento com `POST /sandbox/cashin/{cashin_id}/pay`.
- [ ] Validar `paid` + `sent` e o `settlement_tx_hash`.
- [ ] Configurar webhook HTTPS e validar HMAC, `event_id` e retry.
- [ ] Registrar payloads reais em `docs/pix.md`.

### Etapa 2 — Domínio, config e migration

- [x] Criar `src/domain/pix.ts` com tipos e transições.
- [x] Adicionar configs `PIX_*` e `LUNIUM_*`.
- [x] Criar tabela `pix_charges`.
- [x] Adicionar `pix_charge_id` em `payouts`.
- [x] Adicionar `pix_charge_id` em `provider_events`.
- [x] Generalizar `webhook_events`: `intent_id` nullable + `pix_charge_id`.
- [x] Criar migration e atualizar snapshots Drizzle.
- [x] Atualizar `truncateAll` dos testes.

### Etapa 3 — Adapter Lunium

- [x] Criar `src/adapters/lunium/client.ts`.
- [x] Implementar `createCharge`, `getCharge`, `findChargesByExternalId`,
      `getLimits`, `preview`.
- [x] Mapear `{ erro, acao, detail, request_id }`.
- [x] Implementar verificação HMAC do webhook sobre raw body.
- [x] Implementar cliente com timeout, retry para 429/5xx e `X-Request-ID`.
- [x] Testes unitários com `fetch` fake.

### Etapa 4 — Persistência

- [x] Repositórios de `pix_charges`:
      criar, buscar por id, buscar por external_id, buscar por provider id,
      atualizar status, listar pendentes/liquidados.
- [x] Repositório de eventos de provider para PIX.
- [x] Repositório de webhook outbox aceitando PIX.
- [x] Repositório de payout por `pix_charge_id`.

### Etapa 5 — Serviço de cobrança PIX

- [x] Criar `PixChargeService`.
- [x] Criar registro local `criando` antes de chamar a Lunium.
- [x] Idempotência por `(client_id, external_id)`.
- [x] Mesmo `external_id` com dados diferentes → 409.
- [x] Timeout/5xx → `incerto`; reconciliar por `external_id`.
- [x] Validar CPF/CNPJ (11 ou 14 dígitos) sem persistir em claro.
- [x] Consultar `cashin/limits` antes de criar.
- [x] Suportar `sandbox_scenario` apenas em chave de teste.
- [x] Gerar QR local se `qr_image_url` vier nulo.

### Etapa 6 — Webhook Lunium e conciliação

- [x] Rota `POST /webhooks/lunium`.
- [x] Verificar assinatura, timestamp e `event_id` do header/body.
- [x] Persistir inbox antes de responder 2xx.
- [x] Worker processa inbox e confirma estado canônico.
- [x] Deduplicar por `event_id`.
- [x] Tolerar eventos fora de ordem.
- [x] Job de reconciliação de cobranças pendentes/incertas.
- [x] Alertas para falha, incerto e manual.

### Etapa 7 — Ledger e payout

- [x] Ao `settlement_status=sent`, converter `asset_amount` para USDC minor.
- [x] Postar `pix_settlement`:
      débito `treasury:usdc`, crédito `merchant:<id>:usdc_available`.
- [x] Criar payout com idempotency `pix:<pix_charge_id>`.
- [x] Reutilizar allowlist, limites, gas, retry e batching do `PayoutService`.
- [x] Sem carteira USDC → `manual` + alerta.
- [x] `PAYOUT_ENABLED=false` → fica `liquidado` e o job pega depois.
- [x] Reversão após `sent` só com revisão manual.
- [x] Webhooks de saída `pix_charge.*`.
- [x] Atualizar `GET /v1/balances`, admin e reconciliação.

### Etapa 8 — API

- [x] `POST /v1/pix-charges`.
- [x] `GET /v1/pix-charges/:id`.
- [x] `GET /v1/pix-charges?external_id=`.
- [x] `POST /admin/api/pix-charges/:id/sync`.
- [x] `GET /admin/api/pix-charges`.
- [x] Escopos `pix:write` e `pix:read` (ou reutilizar `payments:*`).
- [x] Rate limit e validação Zod.

### Etapa 9 — Worker, servidor e observabilidade

- [x] Instanciar `LuniumClient` e `PixChargeService` no server/worker.
- [x] Job `pix-reconcile`.
- [x] Job `pix-inbox` ou processamento no job existente.
- [x] Métricas de cobranças, webhooks e liquidação PIX (hoje só há gauge por status).
- [x] Alertas e logs com redaction de CPF/CNPJ.
- [x] Readiness check da Lunium quando `PIX_ENABLED=true`.

### Etapa 10 — Testes e documentação

- [x] Unit: adapter, erros, HMAC, state machine.
- [x] Integração: criação idempotente, paid, settled, duplicata e webhook.
- [x] Integração: expirado, reembolsado, falhou, sem carteira e reconciliação.
- [ ] Sandbox manual com R$ 25,00.
- [x] Atualizar `.env.example` e `.env.production.example`.
- [x] Criar `docs/pix.md`.
- [x] Atualizar `docs/api.md`, `docs/webhooks.md`, `docs/runbook.md`,
      `docs/observability.md`.
- [x] Adicionar seção PIX em `test-real.md`.
- [x] Rodar `npm run typecheck`, `npm test`, `npm run test:integration`,
      `npm run build`.
- [x] Última execução: typecheck OK; 73 unit tests; 54 integration tests; build OK.

## Critérios de aceite do MVP

- [x] Cobrança PIX cria QR e expiração.
- [x] Pagamento confirmado gera `pix_charge.paid`.
- [x] Liquidação gera saldo USDC no ledger da loja.
- [ ] Payout USDC é criado e confirmado na Base.
- [x] Webhook duplicado não duplica crédito.
- [x] Timeout nunca cria cobrança duplicada.
- [x] Loja sem carteira fica em `manual` com alerta.
- [x] Reconciliação e métricas enxergam PIX.
- [x] Fluxo BTC continua passando sem regressão.
- [x] Teste de timeout sem criar cobrança duplicada.
- [x] Teste de loja sem carteira USDC → `manual` + alerta.
- [x] Teste de reversão/refund após liquidação.
