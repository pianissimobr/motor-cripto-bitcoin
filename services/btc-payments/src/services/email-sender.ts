import type { Logger } from '../logger.js';

export type SecurityNotice = {
  to: string;
  subject: string;
  text: string;
};

export interface EmailSender {
  /** Aviso de seguranca (ex.: carteira de recebimento trocada). */
  sendSecurityNotice(input: SecurityNotice): Promise<void>;
}

/**
 * Envio de e-mail plugável. No MVP nada é enviado: o aviso é registrado no
 * log. Troque por SMTP/Resend/SES implementando a interface.
 */
export class NoopEmailSender implements EmailSender {
  constructor(private readonly logger?: Logger) {}

  async sendSecurityNotice(input: SecurityNotice): Promise<void> {
    this.logger?.warn(
      { to: input.to, subject: input.subject },
      'aviso de seguranca por e-mail (noop: configure um provedor de e-mail)',
    );
  }
}