# Deployment, endpoints e topologia

## Endpoints escolhidos

### THORChain

```text
https://thornode.ninerealms.com
https://thornode.thorswap.net
```

O `ThorchainClient` consulta os dois em paralelo, compara `inbound_address`,
`memo` e `expected_amount_out`, e aborta se houver divergencia acima de
`CONVERSION_QUOTE_TOLERANCE_BPS`.

### Base RPC

```text
https://mainnet.base.org
https://base-rpc.publicnode.com
```

Usados via `fallback` do `viem` em `BASE_RPC_URLS`, separados por virgula.
Nao coloque RPC pago/privado em repositorio; sobrescreva no secret manager.

## Topologia do prototipo

```text
Internet
  -> Caddy (80/443)
  -> API btc-payments (4580)
  -> Worker btc-payments
  -> Postgres
  -> LNbits
  -> Esplora/electrs -> Bitcoin Core

Worker/API -> THORChain publico
Worker/API -> Base RPC publico
Worker -> signer BTC remoto
Worker/API -> signer de payout Base remoto
Worker/API -> Lunium (PIX -> USDC)
```

Rede privada WireGuard/Tailscale entre API, worker, Postgres, LNbits, Esplora e
signers. Postgres, RPC e signer nao devem ter porta publica.

## Hardware

| Componente | Prototipo | Producao pequena |
|---|---|---|
| Bitcoin Core + Esplora/electrs | 8 vCPU, 32 GB RAM, 2 TB NVMe, 1 Gbps | 16 vCPU, 64 GB RAM, 4 TB NVMe RAID1 |
| API + worker | 4 vCPU, 16 GB RAM, 200 GB NVMe | 2x 8 vCPU, 32 GB RAM, 500 GB NVMe |
| Postgres | 4 vCPU, 16 GB RAM, 200 GB NVMe | Gerenciado com HA + replica |
| LNbits | 2 vCPU, 4 GB RAM, 100 GB NVMe | 4 vCPU, 8 GB RAM, HA |
| Signer/HSM | 2 vCPU, 4 GB RAM + HSM | HSM/remote signer dedicado, redundante |
| Base RPC | Gerenciado + fallback | Gerenciado + OP node opcional |
| THORChain | 2 endpoints publicos | Full node opcional |
| Monitoramento | 2 vCPU, 4 GB, 100 GB | Separado, HA |
| Backup | Offsite criptografado | 3-2-1 com teste de restore |

## Regras de operacao

- API e worker usam o mesmo Postgres e o mesmo `BTC_XPUB`.
- O signer BTC e o signer de payout ficam fora da API.
- O worker le o keystore apenas se `SIGNER_MODE=local`; em producao prefira
  `remote`.
- `TREASURY_BTC_ADDRESS`, `TREASURY_USDC_ADDRESS` e `GAS_BASE_ADDRESS` viram
  `treasury_wallets` no boot.
- Com `PIX_ENABLED=true`, `TREASURY_USDC_ADDRESS` precisa ser a carteira quente
  usada pelo `PayoutService`; a Lunium entrega USDC nela.
- O webhook da Lunium exige URL publica HTTPS e `LUNIUM_WEBHOOK_SECRET`.
- Com `PIX_ENABLED=true`, `/ready` tambem verifica `GET /ping` da Lunium.
- `GET /metrics` deve ser exposto so em rede privada ou com `METRICS_TOKEN`.
- Backup inclui Postgres, `BTC_XPUB`, keystore (se local), mnemonic offline e
  endereco da carteira fria.
