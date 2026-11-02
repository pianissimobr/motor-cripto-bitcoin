import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';
import {
  hashPassword,
  isStrongEnoughPassword,
  verifyPassword,
} from '../crypto/password.js';
import { generateOpaqueToken, hashOpaqueToken } from '../crypto/token.js';
import type { Repositories } from '../db/repositories.js';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors.js';
import type { MerchantMember, User } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { ClientService } from './client-service.js';
import type { EmailSender } from './email-sender.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export type AuthServiceDeps = {
  repos: Repositories;
  clients: ClientService;
  config: AppConfig;
  logger: Logger;
  emailSender: EmailSender;
  now?: () => Date;
};

export type SafeUser = {
  id: string;
  email: string;
  status: User['status'];
  emailVerifiedAt: string | null;
};

export type MerchantView = {
  id: string;
  name: string;
  role: MerchantMember['role'];
  status: string;
  verificationStatus: string;
  apiKeyPrefix: string;
  webhookUrl: string;
};

function safeUser(user: User): SafeUser {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
  };
}

async function merchantsFor(
  repos: Repositories,
  userId: string,
): Promise<MerchantView[]> {
  const rows = await repos.listMerchantsForUser(userId);
  return rows.map(({ member, client }) => ({
    id: client.id,
    name: client.name,
    role: member.role,
    status: client.status,
    verificationStatus: client.verificationStatus,
    apiKeyPrefix: client.apiKeyPrefix,
    webhookUrl: client.webhookUrl,
  }));
}

export class AuthService {
  private readonly now: () => Date;

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private normalizeEmail(email: string): string {
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      throw new ValidationError('email invalido');
    }
    return value;
  }

  async register(input: {
    email: string;
    password: string;
    merchantName?: string;
  }): Promise<{
    user: SafeUser;
    merchant: { id: string; name: string; apiKey: string; requestSecret: string; webhookSecret: string };
    verificationToken: string;
  }> {
    const email = this.normalizeEmail(input.email);
    if (!isStrongEnoughPassword(input.password)) {
      throw new ValidationError('senha deve ter entre 8 e 200 caracteres');
    }

    const existing = await this.deps.repos.findUserByEmail(email);
    if (existing) throw new ConflictError('email ja cadastrado');

    const passwordHash = hashPassword(input.password);
    const user = await this.deps.repos.createUser({
      email,
      passwordHash,
      status: 'pendente_email',
    });

    const verificationToken = generateOpaqueToken();
    await this.deps.repos.createEmailVerificationToken({
      userId: user.id,
      tokenHash: hashOpaqueToken(verificationToken),
      expiresAt: new Date(this.now().getTime() + VERIFY_TOKEN_TTL_MS),
    });
    await this.deps.emailSender.sendVerificationEmail({
      to: email,
      token: verificationToken,
    });

    const merchantName =
      input.merchantName?.trim() ||
      email.split('@')[0]?.slice(0, 80) ||
      'Minha loja';
    const merchant = await this.deps.clients.createMerchant({ name: merchantName });
    await this.deps.repos.createMerchantMember({
      userId: user.id,
      merchantId: merchant.id,
      role: 'owner',
    });

    await this.deps.repos.insertAuditEvent({
      actor: 'portal',
      action: 'user.registered',
      entity: 'user',
      entityId: user.id,
      metadata: { email },
    });

    this.deps.logger.info({ userId: user.id, email }, 'usuario cadastrado');

    return {
      user: safeUser(user),
      merchant: {
        id: merchant.id,
        name: merchant.name,
        apiKey: merchant.apiKey,
        requestSecret: merchant.requestSecret,
        webhookSecret: merchant.webhookSecret,
      },
      verificationToken,
    };
  }

  async verifyEmail(token: string): Promise<{ ok: true }> {
    if (!token) throw new ValidationError('token ausente');
    const record = await this.deps.repos.findEmailVerificationTokenByHash(
      hashOpaqueToken(token),
    );
    if (!record || record.consumedAt || record.expiresAt.getTime() < this.now().getTime()) {
      throw new UnauthorizedError('token de verificacao invalido ou expirado');
    }
    const user = await this.deps.repos.findUserById(record.userId);
    if (!user) throw new NotFoundError('usuario nao encontrado');

    await this.deps.repos.updateUser(user.id, {
      status: 'ativo',
      emailVerifiedAt: this.now(),
    });
    await this.deps.repos.consumeEmailVerificationToken(record.id);
    this.deps.logger.info({ userId: user.id }, 'email verificado');
    return { ok: true };
  }

  async login(email: string, password: string): Promise<{
    sessionToken: string;
    csrfToken: string;
    user: SafeUser;
    merchants: MerchantView[];
  }> {
    const normalized = this.normalizeEmail(email);
    const user = await this.deps.repos.findUserByEmail(normalized);
    const invalid = () => new UnauthorizedError('credenciais invalidas');

    if (!user || user.status === 'bloqueado') throw invalid();
    if (!verifyPassword(password, user.passwordHash)) throw invalid();

    const sessionToken = generateOpaqueToken();
    const csrfToken = generateOpaqueToken();
    await this.deps.repos.createSession({
      userId: user.id,
      tokenHash: hashOpaqueToken(sessionToken),
      csrfTokenHash: hashOpaqueToken(csrfToken),
      expiresAt: new Date(
        this.now().getTime() + this.deps.config.server.sessionTtlSeconds * 1000,
      ),
    });

    await this.deps.repos.insertAuditEvent({
      actor: 'portal',
      action: 'user.login',
      entity: 'user',
      entityId: user.id,
    });

    return {
      sessionToken,
      csrfToken,
      user: safeUser(user),
      merchants: await merchantsFor(this.deps.repos, user.id),
    };
  }

  async me(sessionToken: string): Promise<{
    user: SafeUser;
    merchants: MerchantView[];
  }> {
    const session = await this.findValidSession(sessionToken);
    await this.deps.repos.updateSessionSeen(session.id, this.now());
    const user = await this.deps.repos.findUserById(session.userId);
    if (!user || user.status === 'bloqueado') {
      throw new UnauthorizedError('usuario indisponivel');
    }
    return { user: safeUser(user), merchants: await merchantsFor(this.deps.repos, user.id) };
  }

  private async findValidSession(sessionToken: string) {
    const session = await this.deps.repos.findSessionByTokenHash(
      hashOpaqueToken(sessionToken),
    );
    if (!session || session.revokedAt || session.expiresAt.getTime() < this.now().getTime()) {
      throw new UnauthorizedError('sessao invalida ou expirada');
    }
    return session;
  }

  async getSessionUser(sessionToken: string): Promise<{ userId: string; sessionId: string }> {
    const session = await this.findValidSession(sessionToken);
    return { userId: session.userId, sessionId: session.id };
  }

  /** Exige o token CSRF enviado em header e conferido contra o hash da sessao. */
  async assertCsrf(
    sessionToken: string,
    csrfHeader: string | undefined,
  ): Promise<{ userId: string; sessionId: string }> {
    const session = await this.findValidSession(sessionToken);
    if (!csrfHeader) throw new UnauthorizedError('CSRF ausente');
    const expected = Buffer.from(session.csrfTokenHash);
    const provided = Buffer.from(hashOpaqueToken(csrfHeader));
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new UnauthorizedError('CSRF invalido');
    }
    return { userId: session.userId, sessionId: session.id };
  }

  async logout(sessionToken: string): Promise<{ ok: true }> {
    const session = await this.deps.repos.findSessionByTokenHash(
      hashOpaqueToken(sessionToken),
    );
    if (session) await this.deps.repos.revokeSession(session.id);
    return { ok: true };
  }

  async forgotPassword(email: string): Promise<{
    ok: true;
    resetToken?: string;
  }> {
    const user = await this.deps.repos.findUserByEmail(this.normalizeEmail(email));
    if (user) {
      const resetToken = generateOpaqueToken();
      await this.deps.repos.createPasswordResetToken({
        userId: user.id,
        tokenHash: hashOpaqueToken(resetToken),
        expiresAt: new Date(this.now().getTime() + RESET_TOKEN_TTL_MS),
      });
      await this.deps.emailSender.sendPasswordResetEmail({ to: user.email, token: resetToken });
      // MVP: sem SMTP, o token volta na resposta. Reforçar com provedor real
      // antes de ir a produção (ver decisão "EmailSender plugável").
      return { ok: true, resetToken };
    }
    return { ok: true };
  }

  async resetPassword(token: string, newPassword: string): Promise<{ ok: true }> {
    if (!isStrongEnoughPassword(newPassword)) {
      throw new ValidationError('senha deve ter entre 8 e 200 caracteres');
    }
    const record = await this.deps.repos.findPasswordResetTokenByHash(
      hashOpaqueToken(token),
    );
    if (!record || record.consumedAt || record.expiresAt.getTime() < this.now().getTime()) {
      throw new UnauthorizedError('token de reset invalido ou expirado');
    }
    const user = await this.deps.repos.findUserById(record.userId);
    if (!user) throw new NotFoundError('usuario nao encontrado');

    await this.deps.repos.updateUser(user.id, { passwordHash: hashPassword(newPassword) });
    await this.deps.repos.consumePasswordResetToken(record.id);
    await this.deps.repos.revokeUserSessions(user.id);
    await this.deps.repos.insertAuditEvent({
      actor: 'portal',
      action: 'user.password_reset',
      entity: 'user',
      entityId: user.id,
    });
    return { ok: true };
  }

  async changePassword(
    sessionToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const session = await this.findValidSession(sessionToken);
    const user = await this.deps.repos.findUserById(session.userId);
    if (!user) throw new NotFoundError('usuario nao encontrado');
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      throw new UnauthorizedError('senha atual incorreta');
    }
    if (!isStrongEnoughPassword(newPassword)) {
      throw new ValidationError('senha deve ter entre 8 e 200 caracteres');
    }
    await this.deps.repos.updateUser(user.id, { passwordHash: hashPassword(newPassword) });
    await this.deps.repos.revokeUserSessions(user.id);
    await this.deps.repos.insertAuditEvent({
      actor: 'portal',
      action: 'user.password_changed',
      entity: 'user',
      entityId: user.id,
    });
    return { ok: true };
  }
}