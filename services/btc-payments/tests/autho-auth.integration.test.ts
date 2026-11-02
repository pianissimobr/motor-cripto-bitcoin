import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthoIssuerClient } from '../src/adapters/autho/client.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbClient } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { silentLogger } from '../src/logger.js';
import { AuthService } from '../src/services/auth-service.js';
import { ClientService } from '../src/services/client-service.js';
import { NoopEmailSender } from '../src/services/email-sender.js';
import { testConfig, truncateAll } from './helpers.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const maybeDescribe = TEST_DB_URL ? describe : describe.skip;

/** authO falso: guarda os codigos emitidos e confere como o real. */
class FakeAutho {
  issued: Array<{ requestId: string; subject: string; email: string; purpose: string; code: string }> = [];
  humanChecks = 0;
  async challenge() {
    return { algorithm: 'SHA-256' };
  }
  async verifyHuman(altcha: string) {
    if (altcha !== 'ok') throw Object.assign(new Error('robo'), { code: 'validation_error' });
    this.humanChecks++;
  }
  async issueCode(input: { subject: string; email: string; purpose: string; altcha?: string }) {
    if (input.altcha !== 'ok') throw Object.assign(new Error('robo'), { code: 'validation_error' });
    const requestId = `req-${this.issued.length + 1}`;
    this.issued.push({ requestId, ...input, code: '123456' });
    return { requestId, email: input.email, expiresAt: '' };
  }
  async verifyCode(input: { requestId: string; subject: string; code: string }) {
    const hit = this.issued.find((i) => i.requestId === input.requestId && i.subject === input.subject);
    if (!hit || hit.code !== input.code) throw Object.assign(new Error('codigo invalido'), { code: 'validation_error' });
    return { email: hit.email, purpose: hit.purpose };
  }
}

maybeDescribe('portal com authO (integration)', () => {
  let db: DbClient;
  let repos: Repositories;
  let config: AppConfig;
  let autho: FakeAutho;
  let auth: AuthService;

  beforeEach(async () => {
    if (!db) {
      db = createDb({ url: TEST_DB_URL!, ssl: false });
      repos = createRepositories(db.db);
    }
    await truncateAll(db);
    config = testConfig();
    autho = new FakeAutho();
    auth = new AuthService({
      repos,
      clients: new ClientService({ repos, config, logger: silentLogger }),
      config,
      logger: silentLogger,
      emailSender: new NoopEmailSender(silentLogger),
      autho: autho as unknown as AuthoIssuerClient,
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('cadastro exige anti-robo e confirma o e-mail pelo codigo', async () => {
    await expect(auth.register({ email: 'a@ex.com', password: 'senha-forte-123' })).rejects.toThrow(/anti-robo/);
    expect(await repos.findUserByEmail('a@ex.com')).toBeNull();

    const reg = await auth.register({ email: 'a@ex.com', password: 'senha-forte-123', altcha: 'ok' });
    expect(reg.verificationRequestId).toBe('req-1');
    expect(reg.verificationToken).toBeUndefined();
    expect((await repos.findUserByEmail('a@ex.com'))?.status).toBe('pendente_email');

    await expect(
      auth.verifyEmailCode({ email: 'a@ex.com', requestId: 'req-1', code: '000000' }),
    ).rejects.toThrow();
    await auth.verifyEmailCode({ email: 'a@ex.com', requestId: 'req-1', code: '123456' });
    expect((await repos.findUserByEmail('a@ex.com'))?.status).toBe('ativo');
    // Segundo envio do mesmo codigo (duplo clique) nao vira erro.
    await expect(
      auth.verifyEmailCode({ email: 'a@ex.com', requestId: 'req-1', code: '123456' }),
    ).resolves.toEqual({ ok: true });
  });

  it('esqueci a senha responde igual com ou sem conta e troca a senha pelo codigo', async () => {
    const reg = await auth.register({ email: 'b@ex.com', password: 'senha-forte-123', altcha: 'ok' });
    await auth.verifyEmailCode({ email: 'b@ex.com', requestId: reg.verificationRequestId!, code: '123456' });

    const ghost = await auth.forgotPassword('ninguem@ex.com', 'ok');
    expect(Object.keys(ghost).sort()).toEqual(['ok', 'requestId']);
    expect(autho.issued.some((i) => i.email === 'ninguem@ex.com')).toBe(false);

    const real = await auth.forgotPassword('b@ex.com', 'ok');
    expect(Object.keys(real).sort()).toEqual(['ok', 'requestId']);

    await auth.resetPasswordWithCode({
      email: 'b@ex.com',
      requestId: real.requestId!,
      code: '123456',
      password: 'senha-nova-456',
    });
    await expect(auth.login('b@ex.com', 'senha-forte-123')).rejects.toThrow();
    expect((await auth.login('b@ex.com', 'senha-nova-456')).sessionToken).toBeTruthy();
  });

  it('codigo de verificacao nao serve para trocar a senha', async () => {
    const reg = await auth.register({ email: 'c@ex.com', password: 'senha-forte-123', altcha: 'ok' });
    await expect(
      auth.resetPasswordWithCode({
        email: 'c@ex.com',
        requestId: reg.verificationRequestId!,
        code: '123456',
        password: 'senha-nova-456',
      }),
    ).rejects.toThrow(/codigo invalido/);
  });

  it('reenvia o codigo de confirmacao sem revelar quem tem conta pendente', async () => {
    await auth.register({ email: 'd@ex.com', password: 'senha-forte-123', altcha: 'ok' });
    await expect(auth.login('d@ex.com', 'senha-forte-123')).rejects.toMatchObject({
      code: 'email_not_verified',
    });
    const again = await auth.resendVerification('d@ex.com', 'ok');
    const ghost = await auth.resendVerification('ninguem@ex.com', 'ok');
    expect(Object.keys(again).sort()).toEqual(Object.keys(ghost).sort());
    await auth.verifyEmailCode({ email: 'd@ex.com', requestId: again.requestId!, code: '123456' });
    expect((await auth.login('d@ex.com', 'senha-forte-123')).sessionToken).toBeTruthy();
  });

  it('login exige anti-robo quando o authO esta ligado', async () => {
    await expect(auth.assertHuman(undefined)).rejects.toThrow(/anti-robo/);
    await auth.assertHuman('ok');
    expect(autho.humanChecks).toBe(1);
  });
});
