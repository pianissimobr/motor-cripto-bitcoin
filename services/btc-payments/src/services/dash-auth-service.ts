import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthoIssuerClient } from '../adapters/autho/client.js';
import type { AppConfig } from '../config.js';
import { hashPassword, isStrongEnoughPassword, verifyPassword } from '../crypto/password.js';
import { generateOpaqueToken, hashOpaqueToken } from '../crypto/token.js';
import type { Repositories } from '../db/repositories.js';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors.js';
import type { MerchantMember, Session, User } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { ClientService } from './client-service.js';
import type { EmailSender } from './email-sender.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const PASSWORD_RULE = 'a senha deve ter entre 8 e 200 caracteres';

/**
 * Hash de uma senha qualquer, calculado uma vez. O login de um e-mail que nao
 * existe confere contra ele para gastar o mesmo tempo do scrypt de uma conta
 * real: sem isso, a demora da resposta dizia quem tem conta.
 */
let dummyHash: string | null = null;
const dummy = (): string => (dummyHash ??= hashPassword(randomUUID()));

export type DashAuthDeps = {
  repos: Repositories;
  clients: ClientService;
  config: AppConfig;
  logger: Logger;
  emailSender?: EmailSender;
  /**
   * authO issuer: codigo por e-mail e anti-robo. Sem ele (so fora de
   * producao; o config recusa o contrario) os codigos sao tokens locais que
   * voltam na resposta, para desenvolvimento e testes.
   */
  autho?: AuthoIssuerClient;
  now?: () => Date;
};

export type SafeUser = {
  id: string;
  email: string;
  status: User['status'];
  email_verified_at: string | null;
};

export type MerchantView = {
  id: string;
  name: string;
  role: MerchantMember['role'];
  status: string;
};

export type SessionView = {
  id: string;
  current: boolean;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string | null;
};

export type SessionMeta = { ip?: string | null; userAgent?: string | null };

function safeUser(user: User): SafeUser {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    email_verified_at: user.emailVerifiedAt?.toISOString() ?? null,
  };
}

/**
 * Contas do painel do lojista: cadastro, confirmacao de e-mail, login com
 * sessao em cookie, CSRF, troca e recuperacao de senha.
 *
 * Nenhuma resposta diz se um e-mail tem conta: cadastro, reenvio e "esqueci a
 * senha" devolvem o mesmo formato nos dois casos, e o login erra igual (e no
 * mesmo tempo) para e-mail inexistente e senha errada.
 */
export class DashAuthService {
  private readonly now: () => Date;

  constructor(private readonly deps: DashAuthDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get usesAutho(): boolean {
    return this.deps.autho !== undefined;
  }

  private normalizeEmail(email: string): string {
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value) || value.length > 254) {
      throw new ValidationError('e-mail invalido');
    }
    return value;
  }

  /** Id estavel da conta para o authO (o e-mail nao muda neste motor). */
  private subjectFor(email: string): string {
    return `user:${createHash('sha256').update(email).digest('hex')}`;
  }

  private requireAltcha(altcha: string | undefined): string {
    if (!altcha) throw new ValidationError('verificacao anti-robo ausente');
    return altcha;
  }

  /** Anti-robo (login e reenvio), quando o authO esta ligado. */
  async assertHuman(altcha: string | undefined): Promise<void> {
    if (!this.deps.autho) return;
    await this.deps.autho.verifyHuman(this.requireAltcha(altcha));
  }

  private async merchantsFor(userId: string): Promise<MerchantView[]> {
    const rows = await this.deps.repos.listMerchantsForUser(userId);
    return rows.map(({ member, client }) => ({
      id: client.id,
      name: client.name,
      role: member.role,
      status: client.status,
    }));
  }

  private async notify(user: User, subject: string, text: string): Promise<void> {
    try {
      await this.deps.emailSender?.sendSecurityNotice({ to: user.email, subject, text });
    } catch (err) {
      this.deps.logger.warn({ err, userId: user.id }, 'falha ao enviar aviso de seguranca');
    }
  }

  /**
   * Cadastro. Devolve sempre `{ request_id }` (e, fora de producao sem o
   * authO, o token local): um e-mail ja cadastrado recebe a mesma resposta,
   * so que nenhum codigo e emitido.
   */
  async register(input: {
    email: string;
    password: string;
    merchantName?: string;
    altcha?: string;
  }): Promise<{ requestId: string; verificationToken?: string }> {
    if (!this.deps.config.dashboard.signupEnabled) {
      throw new ForbiddenError('cadastro de novas contas fechado no momento');
    }
    const email = this.normalizeEmail(input.email);
    if (!isStrongEnoughPassword(input.password)) throw new ValidationError(PASSWORD_RULE);

    const existing = await this.deps.repos.findUserByEmail(email);
    if (existing) {
      await this.assertHuman(input.altcha);
      this.deps.logger.info({ userId: existing.id }, 'cadastro repetido ignorado');
      return { requestId: randomUUID() };
    }

    // Com o authO o codigo sai antes da conta: se o anti-robo ou o envio
    // falharem, nada e criado.
    let requestId: string = randomUUID();
    if (this.deps.autho) {
      const issued = await this.deps.autho.issueCode({
        subject: this.subjectFor(email),
        email,
        purpose: 'email_verification',
        altcha: this.requireAltcha(input.altcha),
      });
      requestId = issued.requestId;
      if (await this.deps.repos.findUserByEmail(email)) return { requestId };
    }

    const user = await this.deps.repos.createUser({
      email,
      passwordHash: hashPassword(input.password),
      status: 'pendente_email',
    });

    let verificationToken: string | undefined;
    if (!this.deps.autho) {
      verificationToken = generateOpaqueToken();
      await this.deps.repos.createEmailVerificationToken({
        userId: user.id,
        tokenHash: hashOpaqueToken(verificationToken),
        expiresAt: new Date(this.now().getTime() + VERIFY_TOKEN_TTL_MS),
      });
    }

    // A loja nasce junto, sem credenciais visiveis: a chave so e gerada no
    // painel, depois do e-mail confirmado.
    const merchantName =
      input.merchantName?.trim() || email.split('@')[0]?.slice(0, 80) || 'Minha loja';
    const merchant = await this.deps.clients.createMerchant({ name: merchantName });
    await this.deps.repos.createMerchantMember({
      userId: user.id,
      merchantId: merchant.id,
      role: 'owner',
    });
    await this.deps.repos.insertAuditEvent({
      actor: 'painel',
      action: 'user.registered',
      entity: 'user',
      entityId: user.id,
      metadata: { merchantId: merchant.id },
    });
    this.deps.logger.info({ userId: user.id, merchantId: merchant.id }, 'conta do painel criada');

    return {
      requestId,
      ...(verificationToken && !this.deps.config.service.isProduction ? { verificationToken } : {}),
    };
  }

  /** Confirma o e-mail: codigo do authO ou, sem ele, o token local. */
  async verifyEmail(
    input: { token: string } | { email: string; requestId: string; code: string },
  ): Promise<{ ok: true }> {
    if ('token' in input) {
      if (this.deps.autho) throw new ValidationError('use o codigo enviado por e-mail');
      const record = await this.deps.repos.findEmailVerificationTokenByHash(hashOpaqueToken(input.token));
      if (!record || record.consumedAt || record.expiresAt.getTime() < this.now().getTime()) {
        throw new ValidationError('codigo invalido ou expirado');
      }
      const user = await this.deps.repos.findUserById(record.userId);
      if (!user) throw new ValidationError('codigo invalido ou expirado');
      await this.deps.repos.consumeEmailVerificationToken(record.id);
      await this.activate(user);
      return { ok: true };
    }

    if (!this.deps.autho) throw new ValidationError('verificacao por codigo indisponivel');
    const email = this.normalizeEmail(input.email);
    const user = await this.deps.repos.findUserByEmail(email);
    if (!user) throw new ValidationError('codigo invalido');
    // Ja confirmado (duplo clique): o codigo ja foi consumido no authO.
    if (user.emailVerifiedAt) return { ok: true };
    const verified = await this.deps.autho.verifyCode({
      requestId: input.requestId,
      subject: this.subjectFor(email),
      code: input.code,
    });
    if (verified.email !== user.email || verified.purpose !== 'email_verification') {
      throw new ValidationError('codigo invalido');
    }
    await this.activate(user);
    return { ok: true };
  }

  private async activate(user: User): Promise<void> {
    if (user.status === 'bloqueado') return;
    await this.deps.repos.updateUser(user.id, { status: 'ativo', emailVerifiedAt: this.now() });
    this.deps.logger.info({ userId: user.id }, 'e-mail do painel confirmado');
  }

  /** Reenvia o codigo. Mesma resposta exista ou nao uma conta pendente. */
  async resendVerification(
    email: string,
    altcha?: string,
  ): Promise<{ requestId: string; verificationToken?: string }> {
    const normalized = this.normalizeEmail(email);
    const user = await this.deps.repos.findUserByEmail(normalized);
    const pending = user && user.status === 'pendente_email' ? user : null;
    if (this.deps.autho) {
      if (!pending) {
        await this.deps.autho.verifyHuman(this.requireAltcha(altcha));
        return { requestId: randomUUID() };
      }
      const issued = await this.deps.autho.issueCode({
        subject: this.subjectFor(normalized),
        email: normalized,
        purpose: 'email_verification',
        altcha: this.requireAltcha(altcha),
      });
      return { requestId: issued.requestId };
    }
    if (!pending) return { requestId: randomUUID() };
    const verificationToken = generateOpaqueToken();
    await this.deps.repos.createEmailVerificationToken({
      userId: pending.id,
      tokenHash: hashOpaqueToken(verificationToken),
      expiresAt: new Date(this.now().getTime() + VERIFY_TOKEN_TTL_MS),
    });
    return {
      requestId: randomUUID(),
      ...(!this.deps.config.service.isProduction ? { verificationToken } : {}),
    };
  }

  async login(
    email: string,
    password: string,
    meta: SessionMeta = {},
  ): Promise<{ sessionToken: string; csrfToken: string; user: SafeUser; merchants: MerchantView[] }> {
    const invalid = () => new UnauthorizedError('e-mail ou senha incorretos');
    let normalized: string;
    try {
      normalized = this.normalizeEmail(email);
    } catch {
      throw invalid();
    }
    const user = await this.deps.repos.findUserByEmail(normalized);
    // Confere a senha mesmo sem conta, contra um hash qualquer: o tempo da
    // resposta nao diz se o e-mail existe.
    const passwordOk = verifyPassword(password, user?.passwordHash ?? dummy());
    if (!user || !passwordOk || user.status === 'bloqueado') throw invalid();
    // So depois da senha certa, para nao revelar quem tem conta pendente.
    if (user.status === 'pendente_email') {
      throw new AppError('confirme seu e-mail antes de entrar', {
        code: 'email_not_verified',
        statusCode: 403,
      });
    }

    const sessionToken = generateOpaqueToken();
    const csrfToken = generateOpaqueToken();
    await this.deps.repos.createSession({
      userId: user.id,
      tokenHash: hashOpaqueToken(sessionToken),
      csrfTokenHash: hashOpaqueToken(csrfToken),
      expiresAt: new Date(this.now().getTime() + this.deps.config.server.sessionTtlSeconds * 1000),
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
    });
    await this.deps.repos.insertAuditEvent({
      actor: 'painel',
      action: 'user.login',
      entity: 'user',
      entityId: user.id,
      metadata: { ip: meta.ip ?? null },
    });
    return {
      sessionToken,
      csrfToken,
      user: safeUser(user),
      merchants: await this.merchantsFor(user.id),
    };
  }

  private async findValidSession(sessionToken: string): Promise<Session> {
    if (!sessionToken) throw new UnauthorizedError('sessao ausente');
    const session = await this.deps.repos.findSessionByTokenHash(hashOpaqueToken(sessionToken));
    if (!session || session.revokedAt || session.expiresAt.getTime() < this.now().getTime()) {
      throw new UnauthorizedError('sessao invalida ou expirada');
    }
    return session;
  }

  private async activeUser(session: Session): Promise<User> {
    const user = await this.deps.repos.findUserById(session.userId);
    if (!user || user.status !== 'ativo') throw new UnauthorizedError('usuario indisponivel');
    return user;
  }

  async me(sessionToken: string): Promise<{ user: SafeUser; merchants: MerchantView[] }> {
    const session = await this.findValidSession(sessionToken);
    const user = await this.activeUser(session);
    await this.deps.repos.updateSessionSeen(session.id, this.now());
    return { user: safeUser(user), merchants: await this.merchantsFor(user.id) };
  }

  /** Sessao valida, sem CSRF: so para leitura (GET). */
  async authenticate(sessionToken: string): Promise<{ user: User; session: Session }> {
    const session = await this.findValidSession(sessionToken);
    return { user: await this.activeUser(session), session };
  }

  /** Sessao valida + header CSRF conferido contra o hash da sessao (escrita). */
  async authenticateWrite(
    sessionToken: string,
    csrfHeader: string | undefined,
  ): Promise<{ user: User; session: Session }> {
    const session = await this.findValidSession(sessionToken);
    if (!csrfHeader) throw new ForbiddenError('CSRF ausente');
    const expected = Buffer.from(session.csrfTokenHash);
    const provided = Buffer.from(hashOpaqueToken(csrfHeader));
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new ForbiddenError('CSRF invalido');
    }
    return { user: await this.activeUser(session), session };
  }

  /** Confere a senha atual (passo extra antes de mudar carteira, por exemplo). */
  assertPassword(user: User, password: string): void {
    if (!verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedError('senha incorreta');
    }
  }

  async logout(sessionToken: string): Promise<void> {
    const session = await this.deps.repos.findSessionByTokenHash(hashOpaqueToken(sessionToken));
    if (session) await this.deps.repos.revokeSession(session.id);
  }

  async listSessions(user: User, current: Session): Promise<SessionView[]> {
    const rows = await this.deps.repos.listActiveSessionsForUser(user.id, this.now());
    return rows.map((row) => ({
      id: row.id,
      current: row.id === current.id,
      user_agent: row.userAgent,
      ip: row.ip,
      created_at: row.createdAt.toISOString(),
      last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    }));
  }

  async revokeSession(user: User, sessionId: string): Promise<void> {
    const ok = await this.deps.repos.revokeSessionForUser(sessionId, user.id);
    if (!ok) throw new NotFoundError('sessao nao encontrada');
  }

  /** "Sair de todas": revoga tudo menos a sessao atual. */
  async revokeOtherSessions(user: User, current: Session): Promise<number> {
    return this.deps.repos.revokeUserSessions(user.id, current.id);
  }

  /** "Esqueci a senha". Mesma resposta exista ou nao a conta. */
  async forgotPassword(
    email: string,
    altcha?: string,
  ): Promise<{ requestId: string; resetToken?: string }> {
    const normalized = this.normalizeEmail(email);
    const user = await this.deps.repos.findUserByEmail(normalized);
    if (this.deps.autho) {
      if (!user) {
        await this.deps.autho.verifyHuman(this.requireAltcha(altcha));
        return { requestId: randomUUID() };
      }
      const issued = await this.deps.autho.issueCode({
        subject: this.subjectFor(normalized),
        email: normalized,
        purpose: 'password_reset',
        altcha: this.requireAltcha(altcha),
      });
      return { requestId: issued.requestId };
    }
    if (!user) return { requestId: randomUUID() };
    const resetToken = generateOpaqueToken();
    await this.deps.repos.createPasswordResetToken({
      userId: user.id,
      tokenHash: hashOpaqueToken(resetToken),
      expiresAt: new Date(this.now().getTime() + RESET_TOKEN_TTL_MS),
    });
    return {
      requestId: randomUUID(),
      ...(!this.deps.config.service.isProduction ? { resetToken } : {}),
    };
  }

  async resetPassword(
    input:
      | { token: string; password: string }
      | { email: string; requestId: string; code: string; password: string },
  ): Promise<{ ok: true }> {
    if (!isStrongEnoughPassword(input.password)) throw new ValidationError(PASSWORD_RULE);
    let user: User | null;
    if ('token' in input) {
      if (this.deps.autho) throw new ValidationError('use o codigo enviado por e-mail');
      const record = await this.deps.repos.findPasswordResetTokenByHash(hashOpaqueToken(input.token));
      if (!record || record.consumedAt || record.expiresAt.getTime() < this.now().getTime()) {
        throw new ValidationError('codigo invalido ou expirado');
      }
      await this.deps.repos.consumePasswordResetToken(record.id);
      user = await this.deps.repos.findUserById(record.userId);
    } else {
      if (!this.deps.autho) throw new ValidationError('recuperacao por codigo indisponivel');
      const email = this.normalizeEmail(input.email);
      user = await this.deps.repos.findUserByEmail(email);
      if (!user) throw new ValidationError('codigo invalido');
      const verified = await this.deps.autho.verifyCode({
        requestId: input.requestId,
        subject: this.subjectFor(email),
        code: input.code,
      });
      if (verified.email !== user.email || verified.purpose !== 'password_reset') {
        throw new ValidationError('codigo invalido');
      }
    }
    if (!user) throw new ValidationError('codigo invalido');

    // Quem recupera a senha provou o e-mail: uma conta pendente fica ativa.
    await this.deps.repos.updateUser(user.id, {
      passwordHash: hashPassword(input.password),
      ...(user.status === 'pendente_email' ? { status: 'ativo', emailVerifiedAt: this.now() } : {}),
    });
    await this.deps.repos.revokeUserSessions(user.id);
    await this.deps.repos.insertAuditEvent({
      actor: 'painel',
      action: 'user.password_reset',
      entity: 'user',
      entityId: user.id,
    });
    await this.notify(
      user,
      'Sua senha do painel foi redefinida',
      'A senha da sua conta no painel foi redefinida e todas as sessoes foram encerradas. ' +
        'Se nao foi voce, redefina a senha de novo e fale com o suporte.',
    );
    return { ok: true };
  }

  async changePassword(
    user: User,
    current: Session,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    this.assertPassword(user, currentPassword);
    if (!isStrongEnoughPassword(newPassword)) throw new ValidationError(PASSWORD_RULE);
    await this.deps.repos.updateUser(user.id, { passwordHash: hashPassword(newPassword) });
    // As outras sessoes caem; a atual continua (quem trocou esta nela).
    await this.deps.repos.revokeUserSessions(user.id, current.id);
    await this.deps.repos.insertAuditEvent({
      actor: 'painel',
      action: 'user.password_changed',
      entity: 'user',
      entityId: user.id,
    });
    await this.notify(
      user,
      'Sua senha do painel foi alterada',
      'A senha da sua conta no painel foi alterada. As outras sessoes foram encerradas. ' +
        'Se nao foi voce, use "esqueci a senha" e fale com o suporte.',
    );
    return { ok: true };
  }
}
