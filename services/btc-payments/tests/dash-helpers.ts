import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AuthoIssuerClient } from '../src/adapters/autho/client.js';
import type { AppConfig } from '../src/config.js';
import type { Repositories } from '../src/db/repositories.js';
import { buildApp } from '../src/http/app.js';
import { silentLogger } from '../src/logger.js';
import { ClientService } from '../src/services/client-service.js';
import { DashAuthService } from '../src/services/dash-auth-service.js';
import type { EmailSender, SecurityNotice } from '../src/services/email-sender.js';

/** authO falso: guarda os codigos emitidos e confere como o real. */
export class FakeAutho {
  issued: Array<{ requestId: string; subject: string; email: string; purpose: string; code: string }> = [];
  async challenge() {
    return { algorithm: 'SHA-256', challenge: 'x' };
  }
  async verifyHuman(altcha: string) {
    if (altcha !== 'ok') throw Object.assign(new Error('robo'), { code: 'validation_error' });
  }
  async issueCode(input: { subject: string; email: string; purpose: string; altcha?: string }) {
    if (input.altcha !== 'ok') throw Object.assign(new Error('robo'), { code: 'validation_error' });
    const requestId = `req-${this.issued.length + 1}`;
    this.issued.push({ requestId, ...input, code: '123456' });
    return { requestId, email: input.email, expiresAt: '' };
  }
  async verifyCode(input: { requestId: string; subject: string; code: string }) {
    const hit = this.issued.find((i) => i.requestId === input.requestId && i.subject === input.subject);
    if (!hit || hit.code !== input.code) {
      const { ValidationError } = await import('../src/domain/errors.js');
      throw new ValidationError('codigo invalido');
    }
    return { email: hit.email, purpose: hit.purpose };
  }
}

export class MemoryEmailSender implements EmailSender {
  sent: SecurityNotice[] = [];
  async sendSecurityNotice(input: SecurityNotice): Promise<void> {
    this.sent.push(input);
  }
}

export function buildDashApp(input: {
  config: AppConfig;
  repos: Repositories;
  autho?: FakeAutho;
  emailSender?: EmailSender;
  extra?: Record<string, unknown>;
}): FastifyInstance {
  const { config, repos } = input;
  const clients = new ClientService({ repos, config, logger: silentLogger });
  const autho = input.autho as unknown as AuthoIssuerClient | undefined;
  const dashAuth = new DashAuthService({
    repos,
    clients,
    config,
    logger: silentLogger,
    ...(input.emailSender ? { emailSender: input.emailSender } : {}),
    ...(autho ? { autho } : {}),
  });
  return buildApp({
    config,
    logger: silentLogger,
    readiness: { checks: [] },
    services: {
      config,
      logger: silentLogger,
      repos,
      clients,
      dashAuth,
      ...(autho ? { autho } : {}),
      ...(input.emailSender ? { emailSender: input.emailSender } : {}),
      ...input.extra,
    } as never,
  });
}

/** Cookie de sessao + header CSRF a partir da resposta do login. */
export function sessionFrom(res: LightMyRequestResponse): { cookie: string; csrf: string } {
  const cookies = res.cookies as Array<{ name: string; value: string }>;
  const sid = cookies.find((c) => c.name.endsWith('painel_sid'));
  const csrf = cookies.find((c) => c.name === 'painel_csrf');
  if (!sid || !csrf) throw new Error('login sem cookies');
  return { cookie: `${sid.name}=${sid.value}`, csrf: csrf.value };
}

/** Cadastra, confirma (token local) e entra. */
export async function signupAndLogin(
  app: FastifyInstance,
  email: string,
  password = 'senha-forte-123',
): Promise<{ cookie: string; csrf: string }> {
  const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password, merchant_name: 'Loja ' + email } });
  if (reg.statusCode !== 202) throw new Error(`cadastro: ${reg.body}`);
  const token = reg.json().verification_token as string;
  const ver = await app.inject({ method: 'POST', url: '/auth/verify-email', payload: { token } });
  if (ver.statusCode !== 200) throw new Error(`verificacao: ${ver.body}`);
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`login: ${login.body}`);
  return sessionFrom(login);
}
