import type { Logger } from '../logger.js';

export type OutboundEmail = {
  to: string;
  token: string;
};

export type SecurityNotice = {
  to: string;
  subject: string;
  text: string;
};

export interface EmailSender {
  sendVerificationEmail(input: OutboundEmail): Promise<void>;
  sendPasswordResetEmail(input: OutboundEmail): Promise<void>;
  /** Aviso de seguranca (ex.: carteira de recebimento trocada). */
  sendSecurityNotice(input: SecurityNotice): Promise<void>;
}

/**
 * Envio de e-mail plugável. No MVP nada é enviado: o token é devolvido na
 * resposta (ou registrado por CLI). Troque por SMTP/Resend/SES implementando a
 * interface, sem alterar o fluxo de auth.
 *
 * O token nunca vai inteiro para o log: ele é a credencial que abre a conta.
 */
export class NoopEmailSender implements EmailSender {
  constructor(private readonly logger?: Logger) {}

  async sendVerificationEmail(input: OutboundEmail): Promise<void> {
    this.logger?.info(
      { to: input.to, tokenPrefixo: prefixOf(input.token) },
      'email de verificacao (noop, token devolvido por outro canal)',
    );
  }

  async sendPasswordResetEmail(input: OutboundEmail): Promise<void> {
    this.logger?.info(
      { to: input.to, tokenPrefixo: prefixOf(input.token) },
      'email de redefinicao de senha (noop, token devolvido por outro canal)',
    );
  }

  async sendSecurityNotice(input: SecurityNotice): Promise<void> {
    this.logger?.warn(
      { to: input.to, subject: input.subject },
      'aviso de seguranca por e-mail (noop: configure um provedor de e-mail)',
    );
  }
}

/** Prefixo curto do token: identifica a mensagem sem entregar o segredo. */
function prefixOf(token: string): string {
  return token.slice(0, 6);
}