# Portal do lojista + Checkout — Etapas

> Controle de execução. Marque `[x]` em cada etapa concluída.

## Decisões fixadas

- Frontend: HTML/JS vanilla estático, servido por `@fastify/static`.
- Identidade: 1 usuário → N lojas (workspaces) via `merchant_members`.
- Self-serve: signup cria `user` (pendente_email) + loja default `unverified` + membership `owner`.
- Recorrente: agenda gera cobrança por ciclo + webhook (fase 2). Sem custódia.
- Checkout: página hospedada `/pay/:token` + snippet, no mesmo domínio (porta 4580).
- Senha: `crypto.scrypt` (N=2^17, r=8, p=1) com salt por usuário.
- Sessão: token opaco de 32 bytes, apenas hash em `sessions`; cookie `sid` httpOnly/Secure/SameSite=Lax.
- CSRF: `csrf_token` por sessão, cabeçalho `X-CSRF-Token` nas mutações.
- E-mail (MVP): token devolvido na resposta; `EmailSender` plugável (`noop` por padrão).

---

## FASE 0 — Dependências

- [x] Adicionar `@fastify/cookie` e `@fastify/static` em `services/btc-payments/package.json` (e instalar).

## FASE 1 — Modelo de dados

- [x] Criar migration `0012_portal_users_sessions_members.sql` (gerada como `0012_windy_owl.sql`).
- [x] Adicionar tabelas em `services/btc-payments/src/db/schema.ts`:
  - [x] `users`
  - [x] `merchantMembers`
  - [x] `sessions`
  - [x] `emailVerificationTokens`
  - [x] `passwordResetTokens`
- [x] Adicionar meta snapshot da migration (`migrations/meta/0012_snapshot.json` + `_journal.json`).

## FASE 2 — Auth

- [x] `src/crypto/password.ts` (hash/verify scrypt).
- [x] `src/crypto/token.ts` (gerar + hash de token opaco).
- [x] `src/services/auth-service.ts` (register/verify/login/logout/me/forgot/reset/change).
- [x] `src/services/email-sender.ts` (interface + adapter `noop`).
- [x] Rotas de auth (`/auth/*`) com rate-limit por IP e por e-mail.
- [x] Registrar rotas em `src/http/app.ts`.

## FASE 3 — Portal (API de sessão + frontend)

- [x] Repositório/métodos de `merchantMembers` em `src/db/repositories.ts`.
- [x] Middleware `requireMember` (+ helper de loja do usuário atual).
- [x] `src/services/portal-service.ts` (lojas, carteiras, credenciais, checkout) — implementado em `src/http/portal-routes.ts` + `client-service.ts`.
- [x] Rotas `/v1/portal/*` em `src/http/portal-routes.ts`.
- [x] Frontend `public/` (login, signup, app + css/js).
- [x] Servir estático (`@fastify/static`) em `src/http/app.ts`.

## FASE 4 — Relatórios

- [x] `src/services/report-service.ts`.
- [x] Rotas `.../merchants/:id/reports/{summary,series,by-rail}`.

## FASE 5 — Checkout one-time (público + snippet)

- [x] `GET /pay/:id` (público) e `GET /pay/:id/status`.
- [x] `public/checkout.js` (snippet embeddável).
- [x] Docs de integração one-time (`docs/checkout.md`).

## FASE 6 — Recorrente (pós-MVP)

- [x] Tabelas `subscriptions` + `subscription_charges` (migration `0013_awesome_marrow.sql`).
- [x] Job no worker para gerar cobrança por ciclo + webhook (`subscription-service.ts` + worker).
- [x] Rotas CRUD/pause/resume/cancel de assinaturas.
- [x] UI de assinaturas.

---

## Verificação

- [x] `npm run typecheck` em `services/btc-payments`.
- [x] `npm test` em `services/btc-payments`.
- [x] Testes de integração: auth, isolamento multi-loja (IDOR), segredos (`tests/portal-auth.integration.test.ts`; requer `TEST_DATABASE_URL`).

---

## Ordem de execução

F0 → F1 → F2 → F3 → F4 → F5 → F6, com typecheck/testes ao final de cada fase.