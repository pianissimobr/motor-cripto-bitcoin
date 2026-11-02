# Legacy — motor Polygon / Ramp

Este diretório é o motor **antigo** de stablecoin na Polygon (Ramp), substituído
pelo serviço em [`../services/btc-payments`](../services/btc-payments).

- Porta histórica: `4578`
- Contrato antigo: `/v1/links`, `/p/:token`, `/admin/`
- Bootstrap: `start.py`
- Não implementa o contrato atual (`/v1/payment-intents`, portal, checkout, PIX, USDC).

O código está aqui apenas como referência histórica. Não use para integração
nova. As decisões antigas estão em `PLANO.md`, `projetoo.md` e
`ENDURECIMENTO.md` neste diretório.
