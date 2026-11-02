# Runbook operacional

O motor não guarda dinheiro: Lightning cai na wallet LNbits de cada lojista,
on-chain nos endereços do xpub dele e PIX vira USDC na carteira Base dele. A
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

5. Crie o primeiro cliente (ou deixe o lojista se cadastrar em `/signup`):

```bash
curl -X POST https://$DOMAIN/admin/api/clients \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Loja","webhook_url":"https://loja.example.com/webhooks/btc"}'
```

6. O lojista cadastra as carteiras no portal: wallet LNbits (URL + Invoice
   key), xpub on-chain e endereço USDC na Base para o PIX.

## Monitoramento

- `GET /admin/api/status` (Bearer `ADMIN_TOKEN`): contagens por status de
  cobranças e webhooks, `dueWebhooks`, saúde do Esplora, rede e trilhos ligados.
- Logs do worker: `docker compose -f docker-compose.prod.yml logs -f worker`.
- `GET /metrics` (Bearer `METRICS_TOKEN`): contagens de cobranças, PIX e
  webhooks. Guia em [observability.md](observability.md).
- PIX: `GET /admin/api/pix-charges`; para forçar sincronização use
  `POST /admin/api/pix-charges/:id/sync`. Em timeout de criação a cobrança fica
  `incerto`; nunca crie outra cobrança com o mesmo `external_id`.
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

## Incidentes

### Wallet LNbits de um lojista fora do ar

- A criação de cobrança desse lojista responde 502 e a cobrança fica
  `falha_criacao` (use outro `external_id`). As outras lojas não são afetadas.
- Invoices já emitidas são conferidas pelo `lightning-reconcile` quando a wallet
  voltar. Não marque nada como pago sem a confirmação dela.
- Se o lojista trocou a Invoice key, ele recadastra a carteira no portal.

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

### Rotação de chaves

- API key/request secret: o lojista rotaciona no portal
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
3. No portal: crie a conta, cadastre a wallet LNbits (FakeWallet, Invoice key)
   e um tpub de teste.
4. Gere um checkout, pague a invoice no LNbits e confira `status=pago` e o
   webhook do cliente.
5. Teste on-chain, expiração, pagamento tardio e reorg com
   `bitcoin-cli invalidateblock`.
