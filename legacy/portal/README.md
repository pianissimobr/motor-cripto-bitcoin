# Portal do lojista (aposentado)

O login e o dashboard do lojista, como estavam ate 2026-11-07.

**Por que foi aposentado:** o foco do produto mudou para o app (o APK, que
fala com o motor pela API `/v1/user/*`). O cadastro do lojista passou a ser
feito pela API, e o portal ficou sem uso. Como o portal e a tela de login do
motor, deixar no ar e um risco (superficie de login exposta sem ninguem
atendendo). Por isso ele sai do servico que roda.

**O que continua no ar:** a API HMAC (`/v1/*`), a pagina publica de checkout
(`/pay/:id`), o snippet (`/checkout.js`) e tudo que o app usa
(`/v1/user/*`, `/v1/payment-requests`, `/v1/swap-charges`, `/v1/pix-charges`).

## O que tem aqui

| Arquivo | O que era |
|---|---|
| `public/app.html`, `public/portal.js` | o dashboard (lojas, carteiras, credenciais, checkout, relatorios, assinaturas) |
| `public/login.html`, `public/login.js` | o login |
| `public/signup.html`, `public/signup.js` | o cadastro |
| `public/forgot.html`, `public/forgot.js` | a recuperacao de senha |
| `public/market.js` | o grafico de mercado do dashboard |
| `public/altcha.js` | o anti-robo (ALTCHA) do login |
| `portal-routes.ts` | a API do portal (`/v1/portal/*`) |
| `auth-routes.ts` | a API de login (`/auth/*`) |
| `auth-service.ts` | sessao, token de e-mail e redefinicao de senha |
| `autho-client.ts` | o cliente do authO (issuer de codigos por e-mail) |
| `market-service.ts` | o preco de mercado do dashboard |
| `report-service.ts` | os relatorios do dashboard |
| `tests/` | os testes do portal |

O CSS do dashboard foi para `services/btc-payments/public/checkout.css`
(a pagina de checkout publico usava o mesmo arquivo; o nome antigo era
`portal.css`).

## Como trazer de volta

1. Mova os arquivos de `public/` para `services/btc-payments/public/` e
   registre `registerAuthRoutes` e `registerPortalRoutes` em
   `src/http/api-routes.ts`.
2. Volte `auth-service.ts`, `autho-client.ts`, `market-service.ts` e
   `report-service.ts` para `src/`, e as rotas `/login`, `/signup` e
   `/portal` em `src/http/app.ts`.
3. Volte `AUTHO_ISSUER_URL`, `AUTHO_TENANT` e `AUTHO_ISSUER_SECRET` para o
   `.env` (o `config.ts` valida `AUTHO_ISSUER_SECRET` com `AUTHO_ISSUER_URL`).
4. Os metodos `sendVerificationEmail` e `sendPasswordResetEmail` voltam para
   `EmailSender` (eles apontam para `/login.html` e `/forgot.html`).
5. A migration das tabelas (`users`, `merchant_members`, `sessions`,
   `service_flags`, `email_verification_tokens`, `password_reset_tokens`)
   continua no schema: elas nao foram apagadas.

O `authO` precisa estar de pe para o portal funcionar: sem ele o login usa
token local (so desenvolvimento).
