import { createHmac, randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { MotorRepositories } from '../ports/index.js';
import type { LinkStatus, PaymentLink, WebhookEvent } from '../domain/types.js';

/**
 * Entrega de webhooks com outbox.
 *
 * O evento e gravado antes da primeira tentativa. Cada tentativa assina o
 * corpo exato com o segredo do cliente no formato `t=<unix>,v1=<hex>`.
 * Falhas seguem um backoff fixo; depois de `maxAttempts` o evento vira
 * `falhou` e pode ser reenviado pelo admin.
 */

const BACKOFF_SECONDS = [60, 300, 1_800, 7_200, 21_600, 86_400];

export type WebhookPayload = {
  event: 'link.realizado' | 'link.nao_realizado';
  event_id: string;
  created_at: string;
  data: {
    link_id: string;
    external_id: string;
    status: LinkStatus;
    motivo_nao_realizado: string | null;
    valor_fiat_centavos: number;
    moeda_fiat: string;
    valor_recebido_base_units: string;
    chain: string;
    asset: string;
    wallet_address: string;
    expira_em: string;
    liquidacao_ate: string;
  };
};

export function buildWebhookPayload(
  link: PaymentLink,
  eventId: string,
  now = new Date(),
): WebhookPayload {
  const event =
    link.status === 'nao_realizado' ? 'link.nao_realizado' : 'link.realizado';
  return {
    event,
    event_id: eventId,
    created_at: now.toISOString(),
    data: {
      link_id: link.id,
      external_id: link.externalId,
      status: link.status,
      motivo_nao_realizado: link.motivoNaoRealizado,
      valor_fiat_centavos: link.valorFiatCentavos,
      moeda_fiat: link.moedaFiat,
      valor_recebido_base_units: link.valorRecebidoBaseUnits.toString(),
      chain: link.chain,
      asset: link.asset,
      wallet_address: link.walletAddress,
      expira_em: link.expiraEm.toISOString(),
      liquidacao_ate: link.liquidacaoAte.toISOString(),
    },
  };
}

export function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): string {
  const v1 = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export type WebhookServiceDeps = {
  repos: MotorRepositories;
  logger: Logger;
  timeoutMs: number;
  maxAttempts: number;
  /** Injetavel em testes. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type WebhookCycleResult = {
  tentativas: number;
  entregues: number;
  falhas: number;
  erros: string[];
};

export class WebhookService {
  private running = false;

  constructor(private readonly deps: WebhookServiceDeps) {}

  /** Chamado pela maquina de estados quando um link chega a um estado final. */
  async enqueueForLink(link: PaymentLink, status: LinkStatus): Promise<void> {
    if (!['pago', 'pago_sem_gas', 'movido', 'nao_realizado'].includes(status)) return;

    const eventType = status === 'nao_realizado' ? 'nao_realizado' : 'realizado';
    const eventId = randomUUID();
    const payload = buildWebhookPayload({ ...link, status }, eventId, this.now());
    await this.deps.repos.webhooks.enqueue({
      apiClienteId: link.apiClienteId,
      linkId: link.id,
      eventType,
      payload: JSON.stringify(payload),
      nextAttemptEm: this.now(),
    });
  }

  async runCycle(limit = 25): Promise<WebhookCycleResult> {
    const result: WebhookCycleResult = {
      tentativas: 0,
      entregues: 0,
      falhas: 0,
      erros: [],
    };
    if (this.running) return result;
    this.running = true;
    try {
      const due = await this.deps.repos.webhooks.listDue(this.now(), limit);
      for (const event of due) {
        result.tentativas++;
        try {
          const delivered = await this.deliver(event);
          if (delivered) result.entregues++;
          else result.falhas++;
        } catch (err) {
          result.falhas++;
          result.erros.push(
            `${event.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  async replay(eventId: string): Promise<WebhookEvent | null> {
    return this.deps.repos.webhooks.replay(eventId, this.now());
  }

  private async deliver(event: WebhookEvent): Promise<boolean> {
    const client = await this.deps.repos.apiClients.findById(event.apiClienteId);
    if (!client) {
      await this.fail(event, 'cliente da API nao encontrado');
      return false;
    }
    if (client.status !== 'ativo') {
      await this.fail(event, 'cliente da API inativo');
      return false;
    }

    const timestamp = Math.floor(this.now().getTime() / 1000);
    const signature = signWebhook(client.webhookSecret, timestamp, event.payload);
    const fetchImpl = this.deps.fetchImpl ?? fetch;

    let statusCode = 0;
    let errorMessage: string | null = null;
    try {
      const response = await fetchImpl(client.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'motor-cripto-webhook/1',
          'x-webhook-signature': signature,
          'x-webhook-event': event.eventType,
          'x-webhook-delivery': event.id,
        },
        body: event.payload,
        redirect: 'error',
        signal: AbortSignal.timeout(this.deps.timeoutMs),
      });
      statusCode = response.status;
      if (!response.ok) {
        errorMessage = `HTTP ${response.status}`;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    if (statusCode >= 200 && statusCode < 300) {
      await this.deps.repos.webhooks.markDelivered(event.id);
      this.deps.logger.info(
        { eventId: event.id, linkId: event.linkId, statusCode },
        'webhook entregue',
      );
      return true;
    }

    await this.fail(event, errorMessage ?? `HTTP ${statusCode}`);
    return false;
  }

  private async fail(event: WebhookEvent, message: string): Promise<void> {
    const attempts = event.attempts + 1;
    const maxed = attempts >= this.deps.maxAttempts;
    const delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 86_400;
    await this.deps.repos.webhooks.markFailed(event.id, {
      attempts,
      nextAttemptEm: new Date(this.now().getTime() + delay * 1_000),
      lastError: message,
      status: maxed ? 'falhou' : 'pendente',
    });
    this.deps.logger.warn(
      { eventId: event.id, attempts, maxed, erro: message },
      'falha ao entregar webhook',
    );
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}
