import type { Logger } from '../logger.js';

export type AlertLevel = 'warn' | 'error' | 'critical';

export type Alert = {
  level: AlertLevel;
  title: string;
  message?: string;
  metadata?: Record<string, unknown>;
};

export type AlertServiceOptions = {
  webhookUrl?: string;
  token?: string;
  timeoutMs?: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
};

export class AlertService {
  constructor(private readonly opts: AlertServiceOptions) {}

  async send(alert: Alert): Promise<void> {
    if (!this.opts.webhookUrl) return;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(this.opts.webhookUrl, {
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
      }
    } catch (err) {
      this.opts.logger.warn(
        { err, title: alert.title },
        'falha ao enviar alerta',
      );
    }
  }
}
