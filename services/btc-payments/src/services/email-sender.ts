import type { Logger } from '../logger.js';

export type OutboundEmail = {
  to: string;
  token: string;
};

export interface EmailSender {
  sendVerificationEmail(input: OutboundEmail): Promise<void>;
  sendPasswordResetEmail(input: OutboundEmail): Promise<void>;
}

/**
 * Envio de e-mail plugável. No MVP nada é enviado: o token é devolvido na
 * resposta (ou registrado por CLI). Troque por SMTP/Resend/SES implementando a
 * interface, sem alterar o fluxo de auth.
 */
export class NoopEmailSender implements EmailSender {
  constructor(private readonly logger?: Logger) {}

  async sendVerificationEmail(input: OutboundEmail): Promise<void> {
    this.logger?.info(
      { to: input.to, token: input.token },
      'email de verificacao (noop, token devolvido por outro canal)',
    );
  }

  async sendPasswordResetEmail(input: OutboundEmail): Promise<void> {
    this.logger?.info(
      { to: input.to, token: input.token },
      'email de redefinicao de senha (noop, token devolvido por outro canal)',
    );
  }
}