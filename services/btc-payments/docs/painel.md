# Painel do lojista e integração plug and play

O painel (`/painel`) é onde o lojista **gerencia**: carteiras, chaves, webhook,
links de pagamento, faturas e relatórios. Ele **não movimenta dinheiro**: não há
saque nem envio. Os pagamentos caem direto na carteira de dólar digital (USDC)
que o lojista cadastrar, qualquer uma (MetaMask, Trust, exchange).

## Ligar

```
DASHBOARD_ENABLED=true
DASHBOARD_SIGNUP_ENABLED=true     # false fecha o cadastro sem desligar o login
AUTHO_ISSUER_URL=https://auth.libreflowdigital.com
AUTHO_TENANT=...
AUTHO_ISSUER_SECRET=...
```

Em produção o painel exige o authO: ele envia o código de 6 dígitos por e-mail
(cadastro, "esqueci a senha" e confirmação de operação sensível) e o desafio
anti-robô (ALTCHA).

## Contas e segurança

- Sessão em cookie `__Host-painel_sid` (httpOnly, Secure, SameSite=Lax) e CSRF no
  header `x-csrf-token` em toda escrita.
- Nenhuma resposta revela se um e-mail tem conta.
- Limite de 10/min por IP nas rotas de login e cadastro, e trava de 15 minutos
  por e-mail depois de 10 senhas erradas.
- Cadastrar ou trocar carteira, gerar chave de API ou chave de loja de produção:
  senha + código por e-mail (`login_2fa` no authO) e aviso por e-mail aos membros.
- Trocar ou redefinir a senha encerra as outras sessões.

## Fatura hospedada (plataformas)

A loja virtual autentica com a **chave de loja** no header `x-api-key`
(`mk_store_live_…` ou `mk_store_test_…`). A chave só cria e consulta faturas:
vazada, não muda carteira nem desvia dinheiro (a fatura sempre paga a loja).

```
POST /v1/invoices
x-api-key: mk_store_test_...

{
  "price_amount": "99.90",
  "price_currency": "BRL",
  "order_id": "1234",
  "order_description": "Pedido #1234",
  "customer_email": "cliente@exemplo.com",
  "success_url": "https://loja.com/obrigado",
  "cancel_url": "https://loja.com/carrinho",
  "ipn_callback_url": "https://loja.com/ipn",
  "rails": ["pix", "bitcoin"],
  "expires_in_minutes": 60
}
```

Resposta `201` (ou `200` com a mesma fatura quando o `order_id` se repete):

```json
{
  "id": "uuid",
  "order_id": "1234",
  "mode": "test",
  "status": "aguardando",
  "price_amount": "99.90",
  "price_currency": "BRL",
  "invoice_url": "https://cripto.libreflowdigital.com/i/uuid",
  "rails": ["pix", "bitcoin"],
  "paid_rail": null,
  "tx_hash": null,
  "expires_at": "...",
  "paid_at": null
}
```

- `GET /v1/invoices/:id` e `GET /v1/invoices?order_id=` consultam.
- `GET /v1/ping` serve de "testar conexão" e devolve o nome da loja e o modo.
- Em dólar (`USD`), a fatura aceita só Bitcoin, porque o Pix é em real.
- O `ipn_callback_url` precisa ser HTTPS e não pode apontar para a rede interna.

Na página `/i/:id`, o pagador escolhe Pix (informando o CPF ou CNPJ) ou Bitcoin.
A cobrança só é criada nesse momento, uma por fatura. Depois de pago, ele volta
para o `success_url`.

### Estados

| status | quando |
|---|---|
| `aguardando` | ninguém pagou ainda |
| `confirmando` | o Bitcoin chegou e está sendo convertido |
| `pago` | Pix pago, ou USDC entregue na carteira (`paid_rail` diz qual) |
| `expirado` | venceu sem nada em andamento |

### IPN

A cada mudança de estado, a fatura recebe um `POST` no `ipn_callback_url` (ou no
webhook da loja, quando a fatura não tem URL própria). As tentativas seguem o
mesmo esquema do webhook: 1 min, 5 min, 30 min, 2 h, 6 h e 24 h.

- Corpo: `{ "event": "invoice.pago", "event_id", "created_at", "data": <fatura> }`
- Header `x-webhook-signature: t=<unix>,v1=<hex>`, em que `hex` é o
  HMAC-SHA256 do **segredo IPN** sobre `"<t>.<corpo>"`. Recuse diferenças de
  mais de 5 minutos.

Boa prática, e é o que o plugin faz: confira a assinatura, **consulte a fatura
de novo** (`GET /v1/invoices/:id`) e compare o valor com o do pedido antes de
marcá-lo como pago.

### Modo teste

Com a chave `mk_store_test_…`, nenhum provedor é chamado. A página mostra
"Simular pagamento", e o IPN sai de verdade. Uma chave de teste não enxerga
fatura de produção, e vice-versa.

## Plugins das lojas virtuais

Os plugins ficam em `integrations/`. O `integrations/build.sh`, que o Dockerfile
roda, empacota cada um em `/downloads/` (links no painel, em Integração e API)
com o cliente PHP compartilhado (`integrations/shared/LibreFlowApi.php`).

| Plataforma | Pacote | Pedido aguardando → pago |
|---|---|---|
| WooCommerce 7+ | `libreflow-woocommerce.zip` | pendente → processando |
| PrestaShop 8 | `libreflow-prestashop.zip` | "Aguardando pagamento LibreFlow" → "Pagamento aceito" |
| Magento 2 | `libreflow-magento.zip` (`app/code/Libreflow/Pay`) | pending_payment → processing (fatura offline) |
| OpenCart 4 | `libreflow.ocmod.zip` | situações escolhidas na configuração |
| WHMCS | `libreflow-whmcs.zip` | pagamento registrado na fatura do WHMCS |

Todos seguem o mesmo fluxo:

1. Criar a fatura no checkout e levar o cliente para `/i/:id`.
2. No IPN, conferir a assinatura.
3. Reconsultar a fatura (`GET /v1/invoices/:id`).
4. Comparar valor e moeda com o pedido.
5. Só então mudar o pedido.

O WHMCS não registra pagamento de fatura de teste, para não liberar serviço sem
dinheiro.

Testes feitos:
- **WooCommerce:** WordPress 7.1 + WooCommerce 11.2, de ponta a ponta.
- **PrestaShop:** PrestaShop 8.2, de ponta a ponta. Checkout por HTTP, pedido
  criado pelo controller, IPN real marcando "Pagamento aceito" e IPN forjado
  recusado com 401.
- **Magento, OpenCart e WHMCS:** lint em PHP 7.4 e 8.3, e teste do cliente
  compartilhado (assinatura do motor conferida em PHP). Ainda não foram testados
  numa instalação real.

## Nuvemshop

App de pagamento no programa de parceiros da Nuvemshop. Liga com
`NUVEMSHOP_APP_ID`, `NUVEMSHOP_CLIENT_ID` e `NUVEMSHOP_CLIENT_SECRET`.

### Instalação

1. O lojista clica em "Conectar Nuvemshop" no painel e autoriza o app. O OAuth
   usa um `state` assinado que identifica a loja do motor.
2. No retorno (`/integrations/nuvemshop/callback`), o motor:
   - troca o code pelo token e guarda o token cifrado;
   - registra o provedor de pagamento, com `checkout_js_url` em
     `/integrations/nuvemshop/checkout.js`, opção `libreflow_redirect` do tipo
     `redirect`;
   - registra os webhooks `order/created`, `app/uninstalled` e os de LGPD.

### Pagamento

- O checkout chama `POST /integrations/nuvemshop/process`, que a Nuvemshop
  assina com `X-Signature` RSA. O motor cria a fatura (uma por `attemptId`) e
  devolve `redirect_url` para `/i/:id`, que leva de volta ao `callbackUrls.success`
  da loja.
- `POST /integrations/nuvemshop/cancel?payment_attempt_id=` cancela a fatura,
  sem efeito se já estiver cancelada.

### Aviso de pago

O `process_payment` não traz o número do pedido. Por isso:

1. O webhook `order/created` liga o pedido à tentativa da mesma loja, com o mesmo
   valor e e-mail, feita nas últimas 2 horas.
2. O job `nuvemshop-sync` do worker cria a transação no pedido (`pending`).
3. Quando a fatura é paga, o mesmo job manda o evento `sale`/`success`.

### Depende da Nuvemshop

- Aprovação do app no programa de parceiros e liberação da API de pagamentos
  pelo suporte.
- Cadastro do `process_payment_api` e do `cancel_payment_api` apontando para as
  rotas acima.
- Chave pública da assinatura (`NUVEMSHOP_SIGNING_PUBLIC_KEY`).
- Confirmação, na homologação, do casamento pedido ↔ tentativa e do formato da
  tabela de taxas.

O fluxo foi testado com a API da Nuvemshop simulada, a partir da documentação
deles (versão 2025-03).
