import { randomUUID } from 'node:crypto';
import { verifyWebhookSignature } from '../../crypto/hmac.js';
import type {
  PixProviderSettlementStatus,
  PixProviderStatus,
} from '../../domain/types.js';

export type LuniumCharge = {
  cashin_id: string;
  status: PixProviderStatus;
  settlement_status: PixProviderSettlementStatus | null;
  amount_cents: number;
  asset?: string | null;
  chain?: string | null;
  payout_address?: string | null;
  qr_copypaste?: string | null;
  qr_image_url?: string | null;
  expires_at?: string | null;
  paid_at?: string | null;
  settled_at?: string | null;
  e2e?: string | null;
  payer_name?: string | null;
  lunium_fee_bps?: number | null;
  lunium_fee_fixed_cents?: number | null;
  partner_fee_bps?: number | null;
  fee_total_cents?: number | null;
  net_cents?: number | null;
  asset_amount?: string | null;
  usdt_amount?: string | null;
  sandbox?: boolean;
  withdraw_fee?: string | null;
  settlement_tx_hash?: string | null;
  settlement_tx_url?: string | null;
  error?: string | null;
  external_id?: string | null;
  [key: string]: unknown;
};

export type LuniumChargeList = {
  items?: LuniumCharge[];
};

export type LuniumLimits = {
  payer_tax?: string;
  stage?: string;
  max_amount_cents?: number;
  used_cents?: number;
  available_cents?: number | null;
  instant_available_cents?: number;
  limit_cents?: number | null;
  held_qr?: {
    max_amount_cents?: number;
    available_cents?: number;
    hold_hours?: number;
  } | null;
};

export type LuniumPreview = {
  asset?: string;
  chain?: string;
  amount_cents?: number;
  fee_total_cents?: number;
  net_cents?: number;
  asset_amount?: string;
  usdt_amount?: string;
  withdraw_fee?: string;
  brl_per_asset?: number;
  min_brl_cents?: number;
  sandbox?: boolean;
};

export type CreateLuniumChargeInput = {
  amountCents: bigint;
  payerTaxNumber: string;
  payerName?: string | null;
  externalId: string;
  customerRef?: string | null;
  asset: 'usdc';
  chain: 'base';
  payoutAddress: string;
  sandboxScenario?: string | null;
};

export type LuniumClientOptions = {
  apiUrl: string;
  apiKey: string;
  webhookSecret?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export class LuniumError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly action: string | null;
  readonly requestId: string | null;
  readonly detail: string | null;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: string;
      action?: string | null;
      requestId?: string | null;
      detail?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'LuniumError';
    this.statusCode = options.statusCode ?? 502;
    this.code = options.code ?? 'lunium_error';
    this.action = options.action ?? null;
    this.requestId = options.requestId ?? null;
    this.detail = options.detail ?? null;
  }
}

type ErrorBody = {
  erro?: unknown;
  acao?: unknown;
  detail?: unknown;
  request_id?: unknown;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LuniumClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LuniumClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.webhookSecret = options.webhookSecret ?? null;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createCharge(input: CreateLuniumChargeInput): Promise<LuniumCharge> {
    return this.request<LuniumCharge>('POST', '/cashin/charge', {
      amount_cents: Number(input.amountCents),
      payer_tax_number: input.payerTaxNumber,
      destino: 'cripto',
      asset: input.asset,
      chain: input.chain,
      payout_address: input.payoutAddress,
      external_id: input.externalId,
      ...(input.payerName ? { payer_name: input.payerName } : {}),
      ...(input.customerRef ? { customer_ref: input.customerRef } : {}),
      ...(input.sandboxScenario
        ? { sandbox_scenario: input.sandboxScenario }
        : {}),
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.request<unknown>('GET', '/ping');
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getCharge(cashinId: string): Promise<LuniumCharge> {
    return this.request<LuniumCharge>(
      'GET',
      `/cashin/${encodeURIComponent(cashinId)}/status`,
    );
  }

  async findChargesByExternalId(externalId: string): Promise<LuniumCharge[]> {
    const data = await this.request<LuniumChargeList>(
      'GET',
      `/cashin/charges?external_id=${encodeURIComponent(externalId)}`,
    );
    return data.items ?? [];
  }

  async getLimits(payerTax: string): Promise<LuniumLimits> {
    return this.request<LuniumLimits>(
      'GET',
      `/cashin/limits?payer_tax=${encodeURIComponent(payerTax)}`,
    );
  }

  async preview(input: {
    amountCents: bigint;
    asset: 'usdc';
    chain: 'base';
  }): Promise<LuniumPreview> {
    return this.request<LuniumPreview>('POST', '/cashin/preview', {
      amount_cents: Number(input.amountCents),
      asset: input.asset,
      chain: input.chain,
    });
  }

  verifyWebhook(input: {
    signature: string | null;
    rawBody: string;
    eventId: string | null;
    toleranceSeconds?: number;
  }): { event: string; eventId: string; payload: Record<string, unknown> } {
    if (!this.webhookSecret) {
      throw new LuniumError('LUNIUM_WEBHOOK_SECRET ausente', { statusCode: 503 });
    }
    if (!input.signature) {
      throw new LuniumError('assinatura ausente', { statusCode: 401 });
    }
    if (!verifyWebhookSignature({
      secret: this.webhookSecret,
      header: input.signature,
      body: input.rawBody,
      ...(input.toleranceSeconds !== undefined
        ? { toleranceSeconds: input.toleranceSeconds }
        : {}),
    })) {
      throw new LuniumError('assinatura do webhook invalida', {
        statusCode: 401,
      });
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(input.rawBody) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('payload nao e objeto');
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new LuniumError('corpo do webhook invalido', { statusCode: 400 });
    }

    const eventId =
      typeof payload.event_id === 'string' ? payload.event_id : null;
    if (!eventId || (input.eventId && input.eventId !== eventId)) {
      throw new LuniumError('event_id do webhook invalido', {
        statusCode: 400,
      });
    }
    return {
      event: typeof payload.event === 'string' ? payload.event : 'unknown',
      eventId,
      payload,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const requestId = randomUUID();
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await (this.fetchImpl ?? fetch)(url, {
          method,
          headers: {
            'x-api-key': this.apiKey,
            accept: 'application/json',
            'x-request-id': requestId,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.ok) {
          return (await response.json()) as T;
        }

        const raw = await response.text().catch(() => '');
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }
        const retryable = response.status === 429 || response.status >= 500;
        const error = new LuniumError(
          typeof parsed?.detail === 'string'
            ? parsed.detail
            : `Lunium respondeu HTTP ${response.status}`,
          {
            statusCode: response.status,
            code: typeof parsed?.erro === 'string' ? parsed.erro : 'lunium_error',
            action: typeof parsed?.acao === 'string' ? parsed.acao : null,
            requestId:
              typeof parsed?.request_id === 'string' ? parsed.request_id : requestId,
            detail: raw,
          },
        );
        lastError = error;
        if (!retryable || attempt === 2) throw error;
      } catch (err) {
        if (err instanceof LuniumError) throw err;
        lastError = err;
        if (attempt === 2) {
          throw new LuniumError('falha de rede ao chamar a Lunium', {
            statusCode: 503,
            code: 'lunium_network_error',
            detail: err instanceof Error ? err.message : String(err),
            requestId,
          });
        }
      }
      await sleep(250 * 2 ** attempt);
    }

    throw lastError instanceof Error
      ? lastError
      : new LuniumError('falha ao chamar a Lunium', { statusCode: 503 });
  }
}

export type LuniumErrorOptions = {
  statusCode?: number;
  code?: string;
  action?: string | null;
  requestId?: string | null;
  detail?: string | null;
};

export function isLuniumError(value: unknown): value is LuniumError {
  return value instanceof LuniumError;
}
