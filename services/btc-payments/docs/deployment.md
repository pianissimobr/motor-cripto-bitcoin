# Deployment, endpoints e topologia

## Topologia

```text
Internet
  -> Caddy (80/443)
  -> API btc-payments (4580)
  -> Worker btc-payments
  -> Postgres
  -> Esplora/electrs -> Bitcoin Core      (on-chain)
Worker/API -> wallets LNbits dos lojistas  (Lightning; elas chamam /webhooks/lnbits)
Worker/API -> Lunium                       (PIX -> USDC na carteira do lojista)
Worker     -> Polygon RPC                  (confere a entrega do PIX)
```

Postgres e Esplora nao devem ter porta publica. A API precisa de URL publica
HTTPS para os webhooks do LNbits e da Lunium.

## Hardware

| Componente | Prototipo | Producao pequena |
|---|---|---|
| Bitcoin Core + Esplora/electrs | 8 vCPU, 32 GB RAM, 2 TB NVMe, 1 Gbps | 16 vCPU, 64 GB RAM, 4 TB NVMe RAID1 |
| API + worker | 4 vCPU, 16 GB RAM, 200 GB NVMe | 2x 8 vCPU, 32 GB RAM, 500 GB NVMe |
| Postgres | 4 vCPU, 16 GB RAM, 200 GB NVMe | Gerenciado com HA + replica |
| Polygon RPC | Gerenciado + fallback | Gerenciado + Polygon publico |
| Monitoramento | 2 vCPU, 4 GB, 100 GB | Separado, HA |
| Backup | Offsite criptografado | 3-2-1 com teste de restore |

## Regras de operacao

- API e worker usam o mesmo Postgres e a mesma `DATA_ENCRYPTION_KEY`.
- O servidor nao guarda seed, xprv, keystore nem chave de carteira: o dinheiro
  vai direto para as carteiras dos lojistas.
- `LNBITS_WEBHOOK_BASE_URL` (ou `PUBLIC_BASE_URL`) precisa ser alcancavel pelas
  wallets LNbits dos lojistas.
- O webhook da Lunium exige URL publica HTTPS e `LUNIUM_WEBHOOK_SECRET`.
- Com `PIX_ENABLED=true`, `/ready` tambem verifica `GET /ping` da Lunium.
- `GET /metrics` deve ser exposto so em rede privada ou com `METRICS_TOKEN`.
- Backup: dump do Postgres e a `DATA_ENCRYPTION_KEY` (sem ela, as Invoice keys e
  os segredos das lojas nao abrem).
