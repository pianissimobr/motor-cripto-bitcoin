# Legacy — motor Polygon / Ramp

Este diretório é o motor **antigo** de stablecoin na Polygon (Ramp), substituído
pelo serviço em [`../services/btc-payments`](../services/btc-payments).

- Porta histórica: `4578`
- Contrato antigo: `/v1/links`, `/p/:token`, `/admin/`
- Bootstrap: `start.py`
- Não implementa o contrato atual (`/v1/payment-intents`, checkout, PIX, USDC).

O código está aqui apenas como referência histórica. Não use para integração
nova. As decisões antigas estão em `PLANO.md`, `projetoo.md` e
`ENDURECIMENTO.md` neste diretório.

## [`portal/`](portal/) — o portal do lojista (aposentado em 2026-11-07)

O login e o dashboard do lojista saíram do serviço que roda e ficaram aqui
(veja o [README do portal](portal/README.md) para o que tem dentro e como
trazer de volta).
