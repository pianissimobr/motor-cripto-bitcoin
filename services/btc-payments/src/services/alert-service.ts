import type { Logger } from '../logger.js';
import { sendMail, type SmtpOptions } from '../adapters/email/smtp-client.js';

export type AlertLevel = 'warn' | 'error' | 'critical';

export type Alert = {
  level: AlertLevel;
  title: string;
  message?: string;
  metadata?: Record<string, unknown>;
};

export type AlertDelivery = {
  /** Canais que entregaram o alerta. */
  channels: string[];
  /** Canais que falharam (vazio = tudo certo). */
  failures: string[];
};

export type AlertServiceOptions = {
  webhookUrl?: string;
  token?: string;
  timeoutMs?: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Relay SMTP para o canal de e-mail. */
  smtp?: SmtpOptions;
  emailFrom?: string;
  /** Destinatarios do alerta (um ou mais). */
  emailTo?: string[];
};

const LEVEL_LABEL: Record<AlertLevel, string> = {
  warn: 'aviso',
  error: 'erro',
  critical: 'critico',
};

export class AlertService {
  constructor(private readonly opts: AlertServiceOptions) {}

  /**
   * Entrega o alerta nos canais configurados.
   *
   * Webhook e e-mail sao independentes: a falha de um nao esconde o outro.
   * O retorno diz o que aconteceu — e o que o drill de alerta le para dizer
   * que o canal foi de fato exercitado.
   */
  async send(alert: Alert): Promise<AlertDelivery> {
    const channels: string[] = [];
    const failures: string[] = [];

    if (this.opts.webhookUrl) {
      const ok = await this.sendWebhook(alert);
      if (ok) channels.push('webhook');
      else failures.push('webhook');
    }

    if (this.opts.smtp && this.opts.emailFrom && (this.opts.emailTo?.length ?? 0) > 0) {
      const ok = await this.sendEmail(alert);
      if (ok) channels.push('email');
      else failures.push('email');
    }

    if (channels.length === 0 && failures.length === 0) {
      this.opts.logger.warn(
        { title: alert.title },
        'nenhum canal de alerta configurado: alerta nao foi entregue',
      );
    }

    return { channels, failures };
  }

  private async sendWebhook(alert: Alert): Promise<boolean> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(this.opts.webhookUrl!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'btc-payments-alerts/1',
          ...(this.opts.token
            ? { authorization: `Bearer ${this.opts.token}` }
            : {}),
        },
        body: JSON.stringify({
          service: 'btc-payments',
          created_at: new Date().toISOString(),
          ...alert,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        this.opts.logger.warn(
          { status: response.status, title: alert.title },
          'alerta nao entregue',
        );
        return false;
      }
      return true;
    } catch (err) {
      this.opts.logger.warn(
        { err, title: alert.title },
        'falha ao enviar alerta',
      );
      return false;
    }
  }

  private async sendEmail(alert: Alert): Promise<boolean> {
    const recipients = this.opts.emailTo ?? [];
    const subject = `[motor-cripto] ${LEVEL_LABEL[alert.level]}: ${alert.title}`;
    const lines = [
      `Nivel: ${LEVEL_LABEL[alert.level]}`,
      `Titulo: ${alert.title}`,
      alert.message ? `Mensagem: ${alert.message}` : null,
      alert.metadata
        ? `Contexto: ${JSON.stringify(alert.metadata)}`
        : null,
      `Quando: ${new Date().toISOString()}`,
    ].filter((line): line is string => line !== null);

    try {
      for (const to of recipients) {
        await sendMail(this.opts.smtp!, this.opts.emailFrom!, {
          to,
          subject,
          text: lines.join('\n'),
        });
      }
      this.opts.logger.info(
        { recipients: recipients.length, title: alert.title },
        'alerta enviado por e-mail',
      );
      return true;
    } catch (err) {
      this.opts.logger.warn(
        { err, title: alert.title },
        'falha ao enviar alerta por e-mail',
      );
      return false;
    }
  }
}
