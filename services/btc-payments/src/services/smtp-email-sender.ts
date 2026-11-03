import type { Logger } from '../logger.js';
import { sendMail, type SmtpOptions } from '../adapters/email/smtp-client.js';
import type { EmailSender, OutboundEmail, SecurityNotice } from './email-sender.js';

export type SmtpEmailSenderDeps = {
  smtp: SmtpOptions;
  /** Endereco do remetente (o relay aplica a politica do dominio). */
  from: string;
  /** Base publica do motor: os links do e-mail apontam para o portal. */
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
 * Sem relay configurado o motor continua usando `NoopEmailSender`, mas isso
 * significa que o token de redefinicao de senha e o aviso de troca de
 * carteira nao chegam ao lojista: quem nao conseguir confirmar o e-mail fica
 * sem recuperacao de senha.
 */
export class SmtpEmailSender implements EmailSender {
  constructor(private readonly deps: SmtpEmailSenderDeps) {}

  async sendVerificationEmail(input: OutboundEmail): Promise<void> {
    const link = `${this.deps.publicBaseUrl}/login.html?verify_token=${encodeURIComponent(input.token)}`;
    await this.deliver({
      to: input.to,
      subject: 'Confirme o seu e-mail',
      text:
        'Confirme o seu e-mail para ativar a conta.\n\n' +
        `Cole este codigo na tela de entrada: ${input.token}\n\n` +
        `Ou abra este link: ${link}\n\n` +
        'Se voce nao pediu esta conta, ignore esta mensagem.',
      html:
        '<p>Confirme o seu e-mail para ativar a conta.</p>' +
        `<p>Codigo: <code>${escapeHtml(input.token)}</code></p>` +
        `<p><a href="${escapeHtml(link)}">Confirmar e-mail</a></p>` +
        '<p>Se voce nao pediu esta conta, ignore esta mensagem.</p>',
    });
  }

  async sendPasswordResetEmail(input: OutboundEmail): Promise<void> {
    const link = `${this.deps.publicBaseUrl}/forgot.html?reset_token=${encodeURIComponent(input.token)}`;
    await this.deliver({
      to: input.to,
      subject: 'Redefina sua senha',
      text:
        'Recebemos um pedido de redefinicao de senha.\n\n' +
        `Cole este codigo na tela de recuperacao: ${input.token}\n\n` +
        `Ou abra este link: ${link}\n\n` +
        'Se voce nao pediu isso, ignore esta mensagem: nada muda.',
      html:
        '<p>Recebemos um pedido de redefinicao de senha.</p>' +
        `<p>Codigo: <code>${escapeHtml(input.token)}</code></p>` +
        `<p><a href="${escapeHtml(link)}">Redefinir senha</a></p>` +
        '<p>Se voce nao pediu isso, ignore esta mensagem: nada muda.</p>',
    });
  }

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
