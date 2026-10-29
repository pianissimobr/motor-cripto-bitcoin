# Runbook operacional

## Deploy inicial

1. Aponte o DNS do `DOMAIN` para o servidor.
2. Abra 80/443 no firewall.
3. Gere a carteira em uma maquina confiavel:

```bash
cd services/btc-payments
npm ci
npm run wallet:init
```

4. Guarde o mnemonic offline. Copie `BTC_XPUB` e, se `SIGNER_MODE=local`, o
   `data/keystore.json` para o servidor (`chown 1000:1000`, modo 0600).
5. Crie `.env.production` a partir de `.env.production.example` e preencha:
   - `DOMAIN`, `ADMIN_TOKEN`, `DATA_ENCRYPTION_KEY`;
   - `POSTGRES_*` e `DATABASE_URL`;
   - `BTC_XPUB`, `COLD_WALLET_ADDRESS`;
   - `LNBITS_*` e `ESPLORA_URL`;
   - `SIGNER_MODE` (`remote` recomendado).
6. Suba:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

7. Verifique:

```bash
curl https://$DOMAIN/health
curl https://$DOMAIN/ready
```

8. Crie o primeiro cliente:

```bash
curl -X POST https://$DOMAIN/admin/api/clients \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Loja","webhook_url":"https://loja.example.com/webhooks/btc"}'
```

## Monitoramento

- `GET /admin/api/status` (Bearer `ADMIN_TOKEN`):
  - contagens por status de intents, webhooks e sweeps;
  - `dueWebhooks`, `activeSweeps`;
  - saude do LNbits/Esplora;
  - fingerprint do xpub e modo do signer.
- Logs do worker: `docker compose -f docker-compose.prod.yml logs -f worker`.
- Alertas opcionais: configure `ALERT_WEBHOOK_URL`; o worker envia:
  - job falhou;
  - sweep manual/falhou;
  - pagamento duplicado;
  - reorg.

Consultas uteis:

```sql
select status, count(*) from payment_intents group by status;
select status, count(*) from webhook_events group by status;
select status, count(*) from onchain_sweeps group by status;
select id, external_id, status, expires_at from payment_intents
 where status = 'pendente' order by expires_at limit 20;
select id, event_type, attempts, next_attempt_at, last_error
  from webhook_events where status = 'pendente' order by next_attempt_at limit 20;
```

## Backup

```bash
cd services/btc-payments
BACKUP_KEYSTORE=1 npm run backup
```

Em desenvolvimento, use o compose local:

```bash
COMPOSE_FILE=docker-compose.yml POSTGRES_USER=btc POSTGRES_DB=btc_payments \
  npm run backup
```

Guarde fora do servidor:

- dump do Postgres;
- `data/keystore.json` (se local);
- `BTC_XPUB`;
- mnemonic (offline);
- endereco da carteira fria.

## Restore

1. Pare API e worker.
2. Restaure o banco:

```bash
npm run restore -- backups/btc-payments-....sql.gz
```

3. Rode migrations pendentes:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm migrate
```

4. Restaure o keystore e o `BTC_XPUB` originais. O boot verifica o fingerprint
   do xpub; se nao bater, a API/worker recusam.
5. Suba API e worker e confira `/ready` e `/admin/api/status`.

## Incidentes

### LNbits indisponivel

- `/ready` fica 503.
- Criacao de cobranca retorna 502/falha_criacao.
- Webhooks e conciliacao voltam quando o LNbits retornar.
- Nao marque intents como pagas manualmente sem confirmar no LNbits.

### Esplora indisponivel

- O job `onchain-watch` e `sweep` falham e geram alerta.
- Pagamentos Lightning continuam.
- Nao reinicie o banco para "resolver"; apenas aguarde/ajuste o Esplora.

### Webhook atrasado ou falhando

- Veja `webhook_events` com status `pendente` e `last_error`.
- Reprocesse:

```bash
curl -X POST https://$DOMAIN/admin/api/webhooks/<id>/replay \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Sweep manual/falhou

- Veja `GET /admin/api/sweeps`.
- Se a tx nao existe mais na rede:

```bash
curl -X POST https://$DOMAIN/admin/api/sweeps/<id>/retry \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

- Se a tx esta presa, o RBF automatico tenta ate `SWEEP_MAX_ATTEMPTS`.
- Nunca reenvie um sweep manualmente se a tx antiga ainda estiver na mempool.

### Pagamento duplicado / reorg

- O status fica registrado e um alerta e enviado.
- Pagamento duplicado: revisar estorno manual; nao creditar duas vezes.
- Reorg: aguardar reconfirmacao; o watcher reavalia.

### Rotacao de chaves

- API key/request secret: criar novo cliente/rotacionar no admin (TODO de
  rotacao automatica; por enquanto crie um cliente novo e desative o antigo).
- `DATA_ENCRYPTION_KEY`: use `KEYRING` com a chave antiga e a nova;
  `DATA_ACTIVE_KID` aponta para a nova. Re-cifre os registros antes de remover
  a antiga.
- Keystore: gerar nova carteira exige migrar o `BTC_XPUB` e mover os fundos
  antes de trocar; o fingerprint do banco impede troca silenciosa.

## Smoke em regtest

Validado em 2026-10-29 com Nigiri (bitcoind + electrs + Chopsticks/Esplora):
pagamento on-chain confirmado, sweep para carteira fria, pagamento tardio depois
da expiracao e reorg (`confirmado -> mempool -> confirmado`).

1. Suba `bitcoind`, Esplora/Electrum e LNbits FakeWallet.
2. `npm run migrate && npm run client:create` (ou admin).
3. `npm run dev` e `npm run worker`.
4. `npm run intent:create`.
5. Pague a invoice no LNbits FakeWallet.
6. Confira `status=pago`, o webhook do cliente e o sweep para a carteira fria.
7. Teste expiracao, pagamento tardio e reorg com `bitcoin-cli invalidateblock`.
