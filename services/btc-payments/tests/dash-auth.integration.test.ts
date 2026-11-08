import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { testConfig, truncateAll } from './helpers.js';
import { buildDashApp, FakeAutho, MemoryEmailSender, sessionFrom, signupAndLogin } from './dash-helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

maybeDescribe('painel: conta e sessao (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig({ DASHBOARD_ENABLED: 'true' });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('sem DASHBOARD_ENABLED as rotas nao existem', async () => {
    const app = buildDashApp({ config: testConfig(), repos });
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@ex.com', password: 'x' } });
    expect(res.statusCode).toBe(404);
  });

  it('cadastro, confirmacao, login, /me e logout', async () => {
    const app = buildDashApp({ config, repos });
    const pending = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'Loja@Ex.com', password: 'senha-forte-123', merchant_name: 'Minha Loja' },
    });
    expect(pending.statusCode).toBe(202);

    // Antes de confirmar o e-mail, a senha certa nao entra.
    const early = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'loja@ex.com', password: 'senha-forte-123' } });
    expect(early.statusCode).toBe(403);
    expect(early.json().error.code).toBe('email_not_verified');

    const verified = await app.inject({ method: 'POST', url: '/auth/verify-email', payload: { token: pending.json().verification_token } });
    expect(verified.statusCode).toBe(200);

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'loja@ex.com', password: 'senha-forte-123' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().merchants).toEqual([expect.objectContaining({ name: 'Minha Loja', role: 'owner' })]);
    const sid = (login.cookies as Array<{ name: string; httpOnly?: boolean; sameSite?: string }>).find((c) => c.name === 'painel_sid');
    expect(sid?.httpOnly).toBe(true);
    expect(sid?.sameSite).toBe('Lax');

    const { cookie } = sessionFrom(login);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json().user.email).toBe('loja@ex.com');

    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('nao revela se o e-mail tem conta', async () => {
    const app = buildDashApp({ config, repos });
    await signupAndLogin(app, 'existe@ex.com');
    const again = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'existe@ex.com', password: 'outra-senha-123' } });
    expect(again.statusCode).toBe(202);
    expect(again.json().verification_token).toBeUndefined();
    expect(Object.keys(again.json())).toEqual(['request_id']);

    const wrong = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'existe@ex.com', password: 'errada-123' } });
    const missing = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'naoexiste@ex.com', password: 'errada-123' } });
    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(missing.json().error.message);

    const forgot = await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'naoexiste@ex.com' } });
    expect(forgot.statusCode).toBe(200);
    expect(Object.keys(forgot.json())).toEqual(['request_id']);
  });

  it('escrita exige o CSRF da propria sessao', async () => {
    const app = buildDashApp({ config, repos });
    const a = await signupAndLogin(app, 'a@ex.com');
    const b = await signupAndLogin(app, 'b@ex.com');
    const payload = { current_password: 'senha-forte-123', password: 'nova-senha-123' };

    const none = await app.inject({ method: 'POST', url: '/auth/change-password', headers: { cookie: a.cookie }, payload });
    expect(none.statusCode).toBe(403);
    const other = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie: a.cookie, 'x-csrf-token': b.csrf },
      payload,
    });
    expect(other.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf },
      payload,
    });
    expect(ok.statusCode).toBe(200);
  });

  it('trocar a senha derruba as outras sessoes e avisa por e-mail', async () => {
    const mail = new MemoryEmailSender();
    const app = buildDashApp({ config, repos, emailSender: mail });
    const first = await signupAndLogin(app, 'c@ex.com');
    const secondLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'c@ex.com', password: 'senha-forte-123' } });
    const second = sessionFrom(secondLogin);

    const list = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { cookie: second.cookie } });
    expect(list.json().sessions).toHaveLength(2);

    await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { cookie: second.cookie, 'x-csrf-token': second.csrf },
      payload: { current_password: 'senha-forte-123', password: 'nova-senha-123' },
    });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: first.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: second.cookie } })).statusCode).toBe(200);
    expect(mail.sent.map((m) => m.to)).toEqual(['c@ex.com']);
  });

  it('nao revoga sessao de outro usuario', async () => {
    const app = buildDashApp({ config, repos });
    const a = await signupAndLogin(app, 'd@ex.com');
    const b = await signupAndLogin(app, 'e@ex.com');
    const bSessions = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { cookie: b.cookie } });
    const bId = bSessions.json().sessions[0].id as string;
    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${bId}`,
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf },
    });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: b.cookie } })).statusCode).toBe(200);
  });

  it('trava o e-mail depois de 10 senhas erradas', async () => {
    const app = buildDashApp({ config: testConfig({ DASHBOARD_ENABLED: 'true', RATE_LIMIT_MAX: '1000' }), repos });
    await signupAndLogin(app, 'f@ex.com');
    // O limite por IP da rota (10/min) chega junto: conta o que vier primeiro.
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'f@ex.com', password: 'errada-123' } });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 9).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('cadastro fechado por flag', async () => {
    const app = buildDashApp({ config: testConfig({ DASHBOARD_ENABLED: 'true', DASHBOARD_SIGNUP_ENABLED: 'false' }), repos });
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'g@ex.com', password: 'senha-forte-123' } });
    expect(res.statusCode).toBe(403);
  });

  describe('com authO', () => {
    it('confirma o e-mail e recupera a senha pelo codigo', async () => {
      const autho = new FakeAutho();
      const app = buildDashApp({ config, repos, autho });
      const noBot = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'h@ex.com', password: 'senha-forte-123' } });
      expect(noBot.statusCode).toBe(400);
      expect(await repos.findUserByEmail('h@ex.com')).toBeNull();

      const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'h@ex.com', password: 'senha-forte-123', altcha: 'ok' } });
      expect(reg.json()).toEqual({ request_id: 'req-1' });

      const bad = await app.inject({ method: 'POST', url: '/auth/verify-email', payload: { email: 'h@ex.com', request_id: 'req-1', code: '000000' } });
      expect(bad.statusCode).toBe(400);
      // Token local nao vale com o authO ligado.
      const local = await app.inject({ method: 'POST', url: '/auth/verify-email', payload: { token: 'qualquer' } });
      expect(local.statusCode).toBe(400);
      const ok = await app.inject({ method: 'POST', url: '/auth/verify-email', payload: { email: 'h@ex.com', request_id: 'req-1', code: '123456' } });
      expect(ok.statusCode).toBe(200);

      const forgot = await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email: 'h@ex.com', altcha: 'ok' } });
      const reset = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { email: 'h@ex.com', request_id: forgot.json().request_id, code: '123456', password: 'nova-senha-123' },
      });
      expect(reset.statusCode).toBe(200);

      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'h@ex.com', password: 'nova-senha-123', altcha: 'ok' } });
      expect(login.statusCode).toBe(200);
      const noAltcha = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'h@ex.com', password: 'nova-senha-123' } });
      expect(noAltcha.statusCode).toBe(400);
    });
  });
});
