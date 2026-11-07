# Runbook operacional

O motor não guarda dinheiro: Lightning cai na wallet LNbits de cada lojista,
on-chain nos endereços do xpub dele e PIX vira USDC na carteira Polygon dele. A
operação cuida de cobranças, provas de pagamento e webhooks, não de fundos.

## Deploy inicial

1. Aponte o DNS do `DOMAIN` para o servidor e abra 80/443 no firewall.
2. Crie `.env.production` a partir de `.env.production.example` e preencha:
   - `DOMAIN`, `ADMIN_TOKEN`, `DATA_ENCRYPTION_KEY`, `METRICS_TOKEN`;
   - `POSTGRES_*` e `DATABASE_URL`;
   - `LNBITS_WEBHOOK_TOKEN` e `LNBITS_WEBHOOK_BASE_URL` (URL pública HTTPS);
   - `ESPLORA_URL` (Esplora/electrs self-hosted);
   - `LUNIUM_*`, se o PIX estiver ligado.
3. Suba:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

4. Verifique:

```bash
curl https://$DOMAIN/health
curl https://$DOMAIN/ready
```

5. Crie o primeiro cliente (`POST /admin/api/clients`; o cadastro no portal foi aposentado):

```bash
curl -X POST https://$DOMAIN/admin/api/clients \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Loja","webhook_url":"https://loja.example.com/webhooks/btc"}'
```

6. O lojista cadastra as carteiras pela API: wallet LNbits (URL + Invoice
   key), xpub on-chain e endereço USDC na Polygon para o PIX.
7. Confira os limites da chave da Lunium no `.env.production`
   (`PIX_MIN_BRL_CENTS=102`, `PIX_MAX_BRL_CENTS=600000` — leia de
   `GET /keys/me` → `limits.cashin`; o default antigo recusava R$ 10 que a
   Lunium aceita).
8. A rede de liquidação é a mesma de `PIX_CHAIN` (`polygon`): `PIX_CHAIN`,
   `POLYGON_RPC_URLS`, `POLYGON_CHAIN_ID` e `POLYGON_USDC_ADDRESSES`.

## Monitoramento

- `GET /admin/api/status` (Bearer `ADMIN_TOKEN`): contagens por status de
  cobranças e webhooks, `dueWebhooks`, saúde do Esplora, rede e trilhos ligados.
- Logs do worker: `docker compose -f docker-compose.prod.yml logs -f worker`.
- `GET /metrics` (Bearer `METRICS_TOKEN`): contagens de cobranças, PIX e
  webhooks. Guia em [observability.md](observability.md).
- PIX: `GET /admin/api/pix-charges`; para forçar sincronização use
  `POST /admin/api/pix-charges/:id/sync`. Em timeout de criação a cobrança fica
  `incerto`; nunca crie outra cobrança com o mesmo `external_id`.
- Limite da Lunium (60 req/min por chave): o motor segura em `LUNIUM_RATE_LIMIT_*`
  (fatia da API + fatia do worker, soma abaixo do teto). Em 429 o limitador
  pausa, reduz a taxa e a reconciliação adia o ciclo. Veja
  `btc_payments_lunium_rate_limit_*` em `/metrics`.
- Alertas opcionais em `ALERT_WEBHOOK_URL`: job falhou, pagamento duplicado,
  reorg, valor Lightning divergente, cobrança PIX incerta/manual.

Consultas úteis:

```sql
select status, count(*) from payment_intents group by status;
select status, count(*) from webhook_events group by status;
select status, count(*) from pix_charges group by status;
select id, external_id, status, expires_at from payment_intents
 where status = 'pendente' order by expires_at limit 20;
select id, event_type, attempts, next_attempt_at, last_error
  from webhook_events where status = 'pendente' order by next_attempt_at limit 20;
```

## Backup e restore

```bash
cd services/btc-payments
npm run backup
RESTORE_DATABASE_URL=postgres://btc:btc_dev_password@localhost:5434/btc_payments_restore \
  npm run backup:verify -- backups/btc-payments-....sql.gz
npm run restore -- backups/btc-payments-....sql.gz
```

Guarde fora do servidor: o dump do Postgres e a `DATA_ENCRYPTION_KEY` (ou o
`KEYRING`). Sem a chave, as Invoice keys do LNbits e os segredos das lojas
gravados no banco não abrem. Não há seed, keystore nem carteira da plataforma.

Restore: pare API e worker, restaure o banco, rode as migrations pendentes
(`docker compose ... run --rm migrate`) e suba de novo.

## Deploy

O código chega na VPS por `git archive` (a VPS não clona o repositório):

```bash
cd services/btc-payments
./scripts/deploy.sh            # deploy do HEAD
./scripts/deploy.sh <commit>   # deploy de um commit específico
```

O script extrai o código, confere o `REVISION` no servidor e sobe
`migrate`, `api` e `worker`. **Se o `REVISION` não bater, o código não foi
extraído** — o serviço sobe com a versão antiga (foi o que aconteceu na
primeira vez: o caminho do `git archive` apontava um nível acima e nada
mudava na VPS).

Depois do deploy, sempre:

```bash
curl -s https://$DOMAIN/ready     # db e Lunium precisam estar ok
```

## Incidentes

### Gas station: tesouraria no piso ou chave ausente

- Sintoma: o app recebe 503 "gas station: tesouraria de gas abaixo do piso" ou
  "gas station desabilitada" no `POST /v1/user/gas/topup`.
- A tesouraria e o que paga o gas das saidas do cliente (o usuario tem a
  stablecoin, nao o nativo). Sem ela, o cash-out do app trava.
- `GET /admin/api/status` traz `gasStation` com o saldo da tesouraria.
- Repor a tesouraria: transferir POL para o endereco da tesouraria (a chave e
  `GAS_STATION_PRIVATE_KEY`; o endereco sai de `gasStation.status`). Manter o
  piso: `GAS_STATION_MIN_TREASURY_WEI` (0,1 POL).
- Para instalar uma chave nova, use
  `KEY=0x... scripts/set-gas-station-key.sh 0xENDERECO_ESPERADO` — ele
  confere o endereço antes de gravar, então uma chave trocada não fica
  apontando para a carteira errada.
- Em produção (2026-11-03) a reposição foi exercitada de verdade: `201` com
  receipt `status 0x1` na Polygon, saindo da tesouraria
  `0x4Cd01696Cd0165D6020AB7d8AE866Fdf2feD3855`.
- A tesouraria se paga com o que o motor ganha nas operacoes. Quando ela
  acumula USDC (as taxas), a troca USDC→POL numa DEX e operacao de servidor.

### Cobrança PIX travada em `manual` (conferência da Lunium)

- Sintoma: a cobrança está em `manual` com `provider_status = under_review`.
  A Lunium recebeu o Pix e está conferindo o pagador.
- **Espere**: em uma operação real isso levou ~2 minutos e liberou sozinho
  (o `pix-reconcile` roda a cada 30 s).
- Se passar de 30 min, conferiu o CPF/CNPJ informado com o de quem pagou
  (`GET /cashin/limits?payer_tax=` mostra a régua do pagador).
- Documento divergente: a Lunium devolve o valor e a cobrança vai para
  `reembolsado`. **Não crie outra cobrança com o mesmo `external_id`.**
- Alerta: "cobranca PIX em conferencia na Lunium".

### Cobrança PIX em `manual` com "settlement sem asset_amount valido"

- Causa real (medido em 03/11/2026): a Lunium **não** manda `asset_amount` no
  cash-in; o valor entregue vem em `delivery_accounting.aSacar`, e o
  `usdt_amount` é o valor **comprado** (antes da taxa de saque). Usar o
  `usdt_amount` como mínima da conferência on-chain reprova uma entrega
  válida.
- O motor já lê o `aSacar` (truncado nas 6 casas do token). Se o erro
  aparecer, é sinal de que a Lunium mudou o payload — conferir o
  `provider_payload` gravado na cobrança.

### Wallet LNbits de um lojista fora do ar

- A criação de cobrança desse lojista responde 502 e a cobrança fica
  `falha_criacao` (use outro `external_id`). As outras lojas não são afetadas.
- Invoices já emitidas são conferidas pelo `lightning-reconcile` quando a wallet
  voltar. Não marque nada como pago sem a confirmação dela.
- Se o lojista trocou a Invoice key, ele recadastra a carteira pela API.

### Esplora indisponível

- `/ready` fica 503 e `onchain-watch` falha e alerta. Lightning e PIX continuam.
- Não reinicie o banco para "resolver"; ajuste o Esplora.

### Webhook atrasado ou falhando

- Veja `webhook_events` com status `pendente` e `last_error`.
- Reprocesse:

```bash
curl -X POST https://$DOMAIN/admin/api/webhooks/<id>/replay \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Pagamento duplicado / reorg

- O status fica registrado e um alerta é enviado.
- Pagamento duplicado (Lightning + on-chain): o dinheiro está nas carteiras do
  lojista; o estorno ao cliente é com ele.
- Reorg: aguarde reconfirmação; o watcher reavalia. O lojista gastar o BTC da
  própria carteira não é reorg: o depósito continua confirmado.

### E-mail não sai (token de senha, aviso de carteira)

- Sintoma: o lojista não recebe o código/token nem o aviso de troca de
  carteira; o log mostra `e-mail desativado (EMAIL_SENDER=noop)` no boot ou
  `falha ao enviar aviso de carteira`.
- `EMAIL_SENDER=noop` significa que nada sai: **ninguém consegue redefinir a
  senha**. Configure o relay (`EMAIL_SENDER=smtp`, `SMTP_HOST`, `SMTP_PORT`,
  `EMAIL_FROM`, e `SMTP_USER`/`SMTP_PASS` se o relay exigir autenticação) e
  reinicie a API.
- O log do relay fica fora do container; se o `docker compose logs api` mostrar
  erro de SMTP, o problema é do relay (porta, credencial, `SMTP_SECURE` para a
  465 e `SMTP_STARTTLS` para a 587).

### Rotação de chaves

- API key/request secret: o lojista rotaciona pela API (ou pelo portal, no legado)
  (`.../api-key/rotate`).
- `DATA_ENCRYPTION_KEY`: use `KEYRING` com a chave antiga e a nova;
  `DATA_ACTIVE_KID` aponta para a nova. Re-cifre os registros antes de remover a
  antiga.

## Drills de falha

```bash
npm run drills plan
```

Detalhes em [failure-drills.md](failure-drills.md).

## Smoke em regtest

1. Suba `bitcoind`, Esplora/Electrum e o LNbits FakeWallet (`docker compose up -d`).
2. `npm run migrate`, `npm run dev` e `npm run worker`.
3. Cadastre a wallet LNbits (FakeWallet, Invoice key) pela API
   e um tpub de teste.
4. Gere um checkout, pague a invoice no LNbits e confira `status=pago` e o
   webhook do cliente.
5. Teste on-chain, expiração, pagamento tardio e reorg com
   `bitcoin-cli invalidateblock`.
