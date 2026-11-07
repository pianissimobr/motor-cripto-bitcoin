import type { Logger } from '../logger.js';
import { sendMail, type SmtpOptions } from '../adapters/email/smtp-client.js';
import type { EmailSender, SecurityNotice } from './email-sender.js';

export type SmtpEmailSenderDeps = {
  smtp: SmtpOptions;
  /** Endereco do remetente (o relay aplica a politica do dominio). */
  from: string;
  /** Base publica do motor (usada nos links do aviso). */
  publicBaseUrl: string;
  logger: Logger;
  now?: () => Date;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Envia e-mail pelo relay SMTP configurado.
 *
 * Sem relay configurado o motor continua usando `NoopEmailSender`, e o aviso de
 * troca de carteira nao chega ao lojista.
 */
export class SmtpEmailSender implements EmailSender {
  constructor(private readonly deps: SmtpEmailSenderDeps) {}

  async sendSecurityNotice(input: SecurityNotice): Promise<void> {
    await this.deliver({
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: `<p>${escapeHtml(input.text).replace(/\n/g, '<br>')}</p>`,
    });
  }

  private async deliver(input: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    await sendMail(this.deps.smtp, this.deps.from, {
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      ...(this.deps.now ? { date: this.deps.now() } : {}),
    });
    this.deps.logger.info(
      { to: input.to, subject: input.subject },
      'e-mail enviado',
    );
  }
}
