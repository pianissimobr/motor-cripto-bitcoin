# Testes com dados reais

Checklist dos itens que ficaram pendentes no `plano-estrutural.md` e que
dependem de rede real, testnet, signer, carteira ou fundos de teste.

> Regra: executar em ambiente isolado, com valores mínimos e chaves
> descartáveis. Nunca usar a carteira de produção.

## Pré-requisitos gerais

- [ ] Gerar carteiras Base de teste descartaveis:

```bash
cd services/btc-payments
npm run wallet:base:init
```

- [ ] Copiar `TREASURY_USDC_ADDRESS`, `PAYOUT_HOT_ADDRESS` e
      `BASE_PAYOUT_PRIVATE_KEY` para o ambiente de teste.
- [ ] Abastecer a treasury com ETH na Base para gas.
- [ ] Cadastrar `MERCHANT_USDC_ADDRESS` como carteira `usdc_settlement` da loja.

- [ ] Fazer backup do banco antes de começar:

```bash
cd services/btc-payments
BACKUP_KEYSTORE=1 npm run backup
```

- [ ] Confirmar `BTC_XPUB`, `TREASURY_BTC_ADDRESS`, `TREASURY_USDC_ADDRESS` e
      `GAS_BASE_ADDRESS`.
- [ ] Confirmar que existe uma carteira `usdc_settlement` ativa e allowlisted
      para a loja de teste.
- [ ] Confirmar que o signer da treasury BTC responde em
      `TREASURY_BTC_SIGNER_URL`.
- [ ] Confirmar que o signer de payout responde em `PAYOUT_SIGNER_URL` ou que
      `BASE_PAYOUT_PRIVATE_KEY` está configurada.
- [ ] Anotar `commit`, data, endpoints usados e IDs gerados.

## 1. Validar quote real `BTC -> BASE.USDC`

**Objetivo:** confirmar que os dois endpoints THORChain retornam quote
compatível e que o `ThorchainClient` aceita a resposta.

**Dados necessários:**

- Endpoint THORChain:
  - `https://thornode.ninerealms.com`
  - `https://thornode.thorswap.net`
- USDC Base:
  - `0x833589fCD6EDb6E08F4C7C32D4f71b54BDA02913`
- Endereço de destino USDC descartável.
- Endereço BTC de refund da treasury de teste.
- Valor pequeno, por exemplo `10000` sats.

**Execução sugerida:**

```bash
cd services/btc-payments
npm run build

node --input-type=module -e "
import { ThorchainClient } from './dist/adapters/conversion/thorchain.js';
const client = new ThorchainClient({
  urls: [
    'https://thornode.ninerealms.com',
    'https://thornode.thorswap.net',
  ],
  usdcAddress: '0x833589fCD6EDb6E08F4C7C32D4f71b54BDA02913',
  timeoutMs: 15000,
});
const quote = await client.quote({
  sourceAmountSats: 10000n,
  targetAddress: '0xSEU_ENDERECO_USDC',
  refundAddress: 'SEU_ENDERECO_BTC_DE_REFUND',
  slippageBps: 100,
});
console.log({
  inboundAddress: quote.inboundAddress,
  memo: quote.memo,
  expectedAmountOutMinor: quote.expectedAmountOutMinor.toString(),
  expiresAt: quote.expiresAt.toISOString(),
  sourceUrl: quote.sourceUrl,
});
"
```

**Critérios de aceite:**

- [ ] As duas URLs retornam quote.
- [ ] O client não aborta por divergência de inbound, memo ou valor.
- [ ] `expectedAmountOutMinor` é maior que zero.
- [ ] `expiresAt` está no futuro.
- [ ] O `memo` contém o asset de destino e o endereço USDC.
- [ ] Registrar os dois endpoints e o valor esperado no log de evidências.

**Se falhar:**

- Verificar se `BASE.USDC-0X833...` é aceito pelo THORNode.
- Verificar se o endereço de destino é válido na Base.
- Verificar rate limit/timeout dos endpoints públicos.
- Não prosseguir para o swap se os endpoints divergirem.

## 2. Fazer um swap pequeno de ponta a ponta

**Objetivo:** pagar uma intent pequena, converter BTC para USDC na Base e
receber o payout na carteira da loja.

**Dados necessários:**

- BTC real ou de testnet suportada, em valor mínimo.
- Treasury BTC com saldo confirmado.
- Signer da treasury BTC funcional.
- Carteira USDC Base da loja.
- Carteira quente Base com ETH para gas e USDC para o teste, se o payout for
  automático.
- `CONVERSION_ENABLED=true`
- `PAYOUT_ENABLED=true`
- `CONVERSION_MIN_SATS` baixo o suficiente para o valor do teste.
- `ONCHAIN_CONFIRMATIONS` e `CONVERSION_MIN_CONFIRMATIONS` adequados ao teste.

**Fluxo esperado:**

1. Criar intent pequena via API.
2. Pagar a intent por on-chain ou Lightning.
3. Aguardar confirmação e sweep para a treasury BTC.
4. O worker cria a ordem de conversão.
5. O worker consulta THORChain e envia BTC ao inbound vault.
6. O worker acompanha o status até `convertida`.
7. O ledger registra BTC recebido, conversão e USDC disponível.
8. O payout é criado e, conforme os limites, enviado ou retido.
9. O webhook de liquidação é entregue.

**Comandos úteis:**

```bash
cd services/btc-payments
npm run migrate
npm run dev
# em outro terminal
npm run worker
```

Criar cobrança:

```bash
npm run intent:create
```

Acompanhar:

```sql
select id, external_id, status, paid_amount_sats
  from payment_intents order by created_at desc limit 5;

select id, intent_id, status, provider_order_id, inbound_address,
       target_amount_minor, txids, error
  from conversion_orders order by created_at desc limit 5;

select id, conversion_id, status, txid, amount_in, amount_out, provider_ref
  from conversion_legs order by created_at desc limit 5;

select id, conversion_id, status, txid, amount_minor, destination_address
  from payouts order by created_at desc limit 5;

select kind, reference_type, reference_id
  from ledger_transactions order by created_at desc limit 10;

select event_type, status, attempts, last_error
  from webhook_events order by created_at desc limit 10;
```

**Critérios de aceite:**

- [ ] `conversion_orders.status = 'convertida'`.
- [ ] `target_amount_minor > 0`.
- [ ] `conversion_legs` da THORChain está `confirmado`.
- [ ] `payment_intents.settlement_status = 'convertido'`.
- [ ] Ledger balanceado por ativo.
- [ ] Payout criado com `destination_address` da loja.
- [ ] Webhook `payment_intent.converted` gerado.
- [ ] Se payout automático: `payouts.status = 'confirmado'` e
      `payment_intents.settlement_status = 'pago'`.
- [ ] Registrar `intent_id`, `conversion_id`, `payout_id`, `txid` BTC,
      `txid` Base e o valor recebido.

**Cuidados:**

- [ ] Não interromper o worker durante o envio BTC.
- [ ] Se a quote expirar, o serviço deve recotar; não reenviar manualmente.
- [ ] Se houver refund da THORChain, conferir `reembolsada` e alerta.
- [ ] Não repetir o pagamento achando que falhou: consultar o txid primeiro.

## 3. Validar payout USDC real na Base com `viem`

**Objetivo:** confirmar envio, confirmação e conciliação de um payout USDC na
Base.

**Dados necessários:**

- Carteira quente Base com USDC.
- ETH suficiente para gas; validar `PAYOUT_MIN_GAS_WEI`.
- Carteira `usdc_settlement` allowlisted da loja.
- `PAYOUT_ENABLED=true`.
- `BASE_RPC_URLS` com os dois RPCs.
- `BASE_USDC_ADDRESS=0x833589fCD6EDb6E08F4C7C32D4f71b54BDA02913`.
- `PAYOUT_SIGNER_URL` ou `BASE_PAYOUT_PRIVATE_KEY`.
- Valor pequeno, por exemplo `1.00` USDC.

**Execução:**

1. Garantir uma conversão convertida com valor suficiente.
2. Rodar o worker com payout habilitado.
3. Conferir decisão:
   - abaixo do limite automático: `aprovado` e envio;
   - acima do limite: `pendente`, exigindo approve;
   - carteira nova ou limite diário: `retido`.
4. Aprovar manualmente se necessário:

```bash
curl -X POST "$PUBLIC_BASE_URL/admin/api/payouts/<id>/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

5. Conferir txid no BaseScan e confirmação.

**Critérios de aceite:**

- [ ] `payouts.txid` existe e é uma transação Base válida.
- [ ] `payouts.status = 'confirmado'`.
- [ ] `confirmed_at` preenchido.
- [ ] `payment_intents.settlement_status = 'pago'`.
- [ ] Webhook `payment_intent.payout_sent` e
      `payment_intent.payout_confirmed`.
- [ ] Ledger: `payout_initiated` e `payout_confirmed` balanceados.
- [ ] Saldo da carteira da loja aumentou em USDC.
- [ ] `GET /admin/api/reconciliation` retorna `ok=true`.

**Se falhar:**

- [ ] Verificar gas ETH da carteira quente.
- [ ] Verificar allowance/contrato USDC.
- [ ] Verificar RPC e nonce.
- [ ] Se revertido: conferir `payout_reversed` e
      `payment_intent.payout_failed`.
- [ ] Não reenviar sem confirmar que a tx anterior não confirmou.

## 4. Executar drills com Esplora/Base/signer de teste

**Objetivo:** validar falhas operacionais sem dinheiro real.

**Ambiente recomendado:**

- Bitcoin Core + Esplora/electrs em regtest.
- LNbits com FakeWallet.
- Base Sepolia ou fork local, se o payout for testado.
- Signer de treasury e signer de payout descartáveis.
- Banco separado `btc_payments_drill`.

**Cenários:**

### 4.1 LNbits indisponível

```bash
npm run drills -- stop-lnbits
curl -i "$DRILL_BASE_URL/ready"       # esperado: 503
# criar intent: esperado 502/falha_criacao
npm run drills -- start-lnbits
```

Aceite: `/health` continua 200; `/ready` fica 503; worker alerta; após
restart, reconciliação volta.

### 4.2 Esplora indisponível

Parar o Esplora/electrs e confirmar:

- `onchain-watch` e `sweep` falham e alertam;
- pagamentos Lightning continuam;
- `/ready` fica 503;
- ao voltar, watcher recupera.

### 4.3 Webhook falhando

Criar cliente com `webhook_url` inválida, pagar intent e conferir:

```sql
select event_type, attempts, next_attempt_at, last_error
  from webhook_events where status = 'pendente' order by next_attempt_at;
```

Aceite: retries com backoff e `POST /admin/api/webhooks/:id/replay` funcionando.

### 4.4 Payout revertido

Forçar revert com signer/carteira de teste. Confirmar:

- `payouts.status = 'falhou'`;
- ledger `payout_reversed`;
- webhook `payment_intent.payout_failed`;
- reconciliação `ok=false` até revisão.

### 4.5 Divergência de ledger

Em banco descartável, remover uma entry:

```sql
delete from ledger_entries where id = '<id>';
```

Chamar `GET /admin/api/reconciliation`. Esperado: `ok=false`, alerta crítico e
registro em `reconciliation_runs`.

### 4.6 Restart no meio do sweep

Reiniciar API/worker durante sweep e confirmar:

- nenhum sweep duplicado;
- nenhum lançamento duplicado;
- status converge para `sweepado` ou `manual`;
- alerta se exigir intervenção.


## 5. PIX -> USDC real

**Objetivo:** validar cobrança PIX real na Lunium, entrega de USDC na treasury
da Base e payout para a loja.

**Dados necessários:**

- `LUNIUM_API_KEY` de produção (`lun_live_...`).
- `LUNIUM_WEBHOOK_SECRET` configurado em HTTPS público.
- `TREASURY_USDC_ADDRESS` igual à carteira quente usada pelo `PayoutService`.
- Carteira `usdc_settlement` allowlisted da loja.
- `PIX_ENABLED=true`, `PAYOUT_ENABLED=true`.

**Execução:**

1. Criar cobrança de valor mínimo aceito pela rota USDC/Base.
2. Pagar o QR PIX com o CPF/CNPJ informado na criação.
3. Confirmar `pix_charge.paid`.
4. Confirmar `pix_charge.settled` e o txid Base na treasury.
5. Confirmar payout `confirmado` para a loja.

**Critérios de aceite:**

- [ ] QR PIX exibido e pagamento aceito.
- [ ] `status = 'liquidado'` e `settlement_status = 'convertido'`.
- [ ] Ledger: débito `treasury:usdc` / crédito `merchant:<id>:usdc_available`.
- [ ] `payout_id` preenchido e `settlement_status = 'pago'`.
- [ ] Webhooks `pix_charge.paid`, `pix_charge.settled` e
      `pix_charge.payout_confirmed` recebidos.
- [ ] `GET /admin/api/reconciliation` retorna `ok=true`.

**Falhas esperadas:**

- Timeout na criação → `incerto`; reconciliar por `external_id`, não recriar.
- Webhook duplicado → não duplicar crédito.
- Sem carteira USDC → `manual` + alerta.

## Evidências a registrar

Preencher ao final de cada execução:

```text
Data:
Commit:
Ambiente:
Endpoints THORChain:
RPCs Base:
Quote: inbound / memo / expected / expiry
Intent ID:
Pagamento BTC txid:
Conversion ID:
Swap txid / outbound txid:
USDC recebido:
Payout ID:
Payout txid Base:
Ledger balanceado:
Webhooks recebidos:
PIX charge ID:
PIX E2E:
PIX payout txid Base:
Drills executados:
Falhas encontradas:
Ações tomadas:
```

## Ordem recomendada

1. Quote real.
2. Swap pequeno.
3. Payout real.
4. Drills de falha em ambiente descartável.
5. Só depois liberar produção.
