# API do Motor Cripto

O manual de quem integra e de quem opera é o livro em HTML. Ele descreve o
serviço Bitcoin em `services/btc-payments` (porta local `4580`).

- No repositório: [web/docs/index.html](../web/docs/index.html).
- Índice de rotas: [web/docs/18-referencia.html](../web/docs/18-referencia.html).
- Contrato curto, ao lado do código: [services/btc-payments/docs/api.md](../services/btc-payments/docs/api.md).

Cada capítulo traz o objetivo, o método e o que a API recusa. Este arquivo não
repete os corpos JSON.

O mapa do código está em [guia.md](guia.md).

O processo antigo na porta 4578 ainda pode servir a pasta `web/` em `/docs/`.
O conteúdo dessa pasta é o livro Bitcoin. A API da porta 4578 não implementa
as rotas `/v1/payment-intents`.
