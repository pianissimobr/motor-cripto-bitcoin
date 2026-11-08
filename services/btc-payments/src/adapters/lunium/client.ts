import { randomUUID } from 'node:crypto';
import { verifyWebhookSignature } from '../../crypto/hmac.js';
import type {
  PixProviderSettlementStatus,
  PixProviderStatus,
} from '../../domain/types.js';
import {
  LuniumRateLimiter,
  type RateLimitPriority,
} from './rate-limiter.js';
import type { SettlementChain } from '../../domain/types.js';
import { TtlCache } from './ttl-cache.js';

export type LuniumDeliveryAccounting = {
  /** Ativo entregue (ex.: `USDC`). */
  asset?: string | null;
  /** Quantidade que sai para a carteira do cliente (ja sem a taxa de saque). */
  aSacar?: string | null;
  /** Quantidade comprada no mercado (antes da taxa de saque da rede). */
  usdtGasto?: string | null;
  taxaSaque?: string | null;
  net_cents?: number | null;
  fee_total_cents?: number | null;
  [key: string]: unknown;
};

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
  /** Contabilidade da entrega (producao): `aSacar` e o que chega na carteira. */
  delivery_accounting?: LuniumDeliveryAccounting | null;
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

/** `GET /catalog` — pares de cripto que a Lunium recebe. */
export type LuniumCatalog = {
  updatedAt?: string | null;
  fast?: CatalogRail[];
  convert?: CatalogRail[];
  dex?: Record<string, unknown>;
  stale?: boolean;
};

export type CatalogRail = {
  asset?: string;
  network?: string;
  min_brl_cents?: number;
  max_brl_cents?: number;
  precision?: number;
  fee_bps?: number;
  fee_fixed_cents?: number;
  eta?: string;
  nota?: string;
  deposit_eta?: {
    network: string;
    confirmations: number;
    eta_seconds: number;
    eta: string;
  }[];
};

/** `GET /webhooks/deliveries` (entregas de webhook da Lunium para o motor). */
export type LuniumWebhookDelivery = {
  event_id: string;
  event: string;
  operation_id?: string;
  status: 'pending' | 'sent' | 'failed';
  attempts?: number;
  last_error?: string | null;
  url?: string;
  next_attempt_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

/** `GET /v1/verificar/{e2e}`. */
export type LuniumE2eVerification = {
  verificado: boolean;
  pago: boolean;
  e2e: string;
  valor_brl?: string;
  pago_em?: string;
  recebedor_iniciais?: string | null;
  instituicao?: string | null;
  liquidado_por?: string;
  comprovante_url?: string | null;
};

/** `GET /cashin/events`. */
export type LuniumEventFeed = {
  projeto?: string;
  agora?: string;
  eventos?: { ts: string; fluxo: string; provedor?: string; ref: string; valor?: string; estado?: string; detalhe?: string | null; tx?: string | null }[];
};

/** `GET /pix/keys/lookup` (DICT). */
export type LuniumPixKeyLookup = {
  pix_key: string;
  pix_key_type: 'cpf' | 'cnpj' | 'phone' | 'email' | 'random';
  owner_name: string | null;
  owner_tax_number?: string | null;
  institution_name?: string | null;
  ispb?: string | null;
  verified: boolean;
  source: 'dict' | 'sandbox' | 'disabled';
  checked_at: string;
  cached?: boolean;
  available?: boolean;
};

/** `GET /cashin/catalog` — o que a Lunium entrega no cash-in. */
export type LuniumCashinCatalog = {
  updatedAt?: string | null;
  instant?: CashinCatalogRail[];
  convert?: CashinCatalogRail[];
  dropped?: { asset: string; network: string; motivo: string }[];
  totals?: Record<string, unknown>;
  stale?: boolean;
};

export type CashinCatalogRail = {
  asset: string;
  network?: string;
  eta?: string;
  etaSeconds?: number;
  entregavel?: boolean;
  fastest?: boolean;
  min_brl_cents?: number;
  precision?: number;
  memoRequired?: boolean;
  withdrawFee?: string;
  withdrawMin?: string;
  withdrawMax?: string;
  minBuyAmount?: string;
};

/**
 * Ordem de cash-out (venda de cripto por Pix) na Lunium.
 *
 * O caminho tem três passos: criacao (trava a cotacao), `accept` (devolve o
 * endereco de deposito) e o deposito em si, que o **app** assina e transmite.
 */
export type LuniumCashOut = {
  cashout_id: string;
  state: string;
  asset?: string | null;
  network?: string | null;
  /** Quantidade a depositar, em string decimal. */
  amount?: string | null;
  /** Valor do Pix em reais. */
  brl_amount?: string | null;
  /** Endereco de deposito: so existe depois do accept. */
  deposit_address?: string | null;
  /** Memo/tag (redes com memo). Na Polygon vem null. */
  deposit_tag?: string | null;
  external_id?: string | null;
  pix_key?: string | null;
  pix_key_type?: string | null;
  br_code?: string | null;
  merchant_name?: string | null;
  /** Trilho: FAST, DEX ou CONVERT. */
  path?: string | null;
  /** Reserva operacional de R$ 1,00 por operacao em chave Pix. */
  reserve_brl?: string | null;
  copia_e_cola_buffer_usd?: string | null;
  fee_total_cents?: number | null;
  net_cents?: number | null;
  refund_address?: string | null;
  refund_address_required?: boolean | null;
  refund_amount?: string | null;
  refund_asset?: string | null;
  refund_network?: string | null;
  provider_return_txid?: string | null;
  deposit_from?: string | null;
  pix_e2e?: string | null;
  pix_paid_at?: string | null;
  receipt_url?: string | null;
  receipt_pdf_url?: string | null;
  verify_url?: string | null;
  expires_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  confirmations?: number | null;
  confirmations_required?: number | null;
  failure_reason?: string | null;
  sandbox?: boolean | null;
  timeline?: { state: string; at: string }[] | null;
  [key: string]: unknown;
};

export type LuniumCashOutList = {
  cash_outs?: LuniumCashOut[];
};

/** Corpo de criacao/previsao de cash-out. */
export type LuniumCashOutInput = {
  asset: string;
  network: string;
  /** Valor do Pix em reais (string decimal). Exclusivo com `amount`/`brCode`. */
  brlAmount?: string | null;
  /** Quantidade de cripto a vender (string decimal). Exclusivo com `brlAmount`. */
  amount?: string | null;
  pixKey?: string | null;
  pixKeyType?: string | null;
  /** BR Code do Pix: carrega valor e recebedor. Exclusivo com os outros. */
  brCode?: string | null;
  /** Carteira de devolucao, caso a venda falhe. */
  refundAddress?: string | null;
  externalId?: string | null;
  sandboxScenario?: string | null;
};

export type CreateLuniumChargeInput = {
  amountCents: bigint;
  payerTaxNumber: string;
  payerName?: string | null;
  externalId: string;
  customerRef?: string | null;
  asset: 'usdc';
  chain: SettlementChain;
  payoutAddress: string;
  sandboxScenario?: string | null;
};

export type LuniumClientOptions = {
  apiUrl: string;
  apiKey: string;
  webhookSecret?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Requisições por janela liberadas para a Lunium. */
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
    maxQueue?: number;
  };
  /** TTL do cache do catalogo (ms). */
  catalogCacheMs?: number;
  /** TTL do cache dos limites do pagador (ms). */
  limitsCacheMs?: number;
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
  private readonly limiter: LuniumRateLimiter;
  private readonly catalogCache: TtlCache<LuniumCatalog>;
  private readonly cashinCatalogCache: TtlCache<LuniumCashinCatalog>;
  private readonly limitsCache: TtlCache<LuniumLimits>;

  constructor(options: LuniumClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.webhookSecret = options.webhookSecret ?? null;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limiter = new LuniumRateLimiter({
      maxRequests: options.rateLimit?.maxRequests ?? 55,
      windowMs: options.rateLimit?.windowMs ?? 60_000,
      ...(options.rateLimit?.maxQueue !== undefined
        ? { maxQueue: options.rateLimit.maxQueue }
        : {}),
    });
    this.catalogCache = new TtlCache<LuniumCatalog>({
      ttlMs: options.catalogCacheMs ?? 300_000,
    });
    this.cashinCatalogCache = new TtlCache<LuniumCashinCatalog>({
      ttlMs: options.catalogCacheMs ?? 300_000,
    });
    this.limitsCache = new TtlCache<LuniumLimits>({
      ttlMs: options.limitsCacheMs ?? 20_000,
    });
  }

  /** Limitador em uso (exposto para métricas e diagnóstico). */
  get rateLimiter(): LuniumRateLimiter {
    return this.limiter;
  }

  async createCharge(input: CreateLuniumChargeInput): Promise<LuniumCharge> {
    return this.request<LuniumCharge>(
      'POST',
      '/cashin/charge',
      {
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
      },
      'alta',
    );
  }

  /* ------------------------------------------------------------------ */
  /* Cash-out (venda de cripto por Pix)                                  */
  /* ------------------------------------------------------------------ */

  /**
   * `POST /cash-outs/preview` — previa da cotacao. Nao cria nada.
   *
   * A Lunium exige `br_code` **ou** `pix_key`+`brl_amount`, nunca os dois
   * (400 `campos_conflitantes`).
   */
  async previewCashOut(input: LuniumCashOutInput): Promise<LuniumCashOut> {
    return this.request<LuniumCashOut>(
      'POST',
      '/cash-outs/preview',
      cashOutBody(input),
      'alta',
    );
  }

  /**
   * `POST /cash-outs` — cria a ordem (passo 1 de 3).
   *
   * O `external_id` e a chave de idempotencia: repetir com o mesmo id e o
   * mesmo corpo devolve a mesma ordem.
   */
  async createCashOut(input: LuniumCashOutInput): Promise<LuniumCashOut> {
    return this.request<LuniumCashOut>(
      'POST',
      '/cash-outs',
      cashOutBody(input),
      'alta',
    );
  }

  /**
   * `POST /cash-outs/{id}/accept` — trava a cotacao e devolve o endereco de
   * deposito (passo 2 de 3). Sem corpo.
   */
  async acceptCashOut(cashoutId: string): Promise<LuniumCashOut> {
    return this.request<LuniumCashOut>(
      'POST',
      `/cash-outs/${encodeURIComponent(cashoutId)}/accept`,
      undefined,
      'alta',
    );
  }

  /** `GET /cash-outs/{id}` — estado da ordem (passo 3 de 3). */
  async getCashOut(cashoutId: string): Promise<LuniumCashOut> {
    return this.request<LuniumCashOut>(
      'GET',
      `/cash-outs/${encodeURIComponent(cashoutId)}`,
      undefined,
      'normal',
    );
  }

  /**
   * `GET /cash-outs?external_id=` — recupera a ordem por `external_id`.
   *
   * E o caminho de recuperacao quando a criacao deu timeout: a ordem pode ter
   * sido criada do outro lado.
   */
  async findCashOutsByExternalId(externalId: string): Promise<LuniumCashOut[]> {
    const data = await this.request<LuniumCashOutList>(
      'GET',
      `/cash-outs?external_id=${encodeURIComponent(externalId)}`,
      undefined,
      'normal',
    );
    return data.cash_outs ?? [];
  }

  /** `POST /cash-outs/{id}/refund-address` — informa a carteira de devolucao. */
  async setCashOutRefundAddress(
    cashoutId: string,
    refundAddress: string,
  ): Promise<LuniumCashOut> {
    return this.request<LuniumCashOut>(
      'POST',
      `/cash-outs/${encodeURIComponent(cashoutId)}/refund-address`,
      { refund_address: refundAddress },
      'alta',
    );
  }

  /**
   * `GET /pix/keys/lookup` — titular da chave Pix no DICT (nome, banco e
   * documento mascarado). Consulta auxiliar: `available: false` ou
   * `verified: false` significam "nao deu para conferir", nunca bloqueio.
   */
  async lookupPixKey(key: string, type?: string | null): Promise<LuniumPixKeyLookup> {
    const query = new URLSearchParams({ key, ...(type ? { type } : {}) });
    return this.request<LuniumPixKeyLookup>('GET', `/pix/keys/lookup?${query}`, undefined, 'normal');
  }

  /**
   * `GET /cashin/events` — feed dos eventos recentes da chave (todos os
   * fluxos). Uma chamada diz quais operacoes mudaram, em vez de consultar
   * cada cobranca.
   */
  async getEvents(limit = 200): Promise<LuniumEventFeed> {
    return this.request<LuniumEventFeed>('GET', `/cashin/events?limit=${Math.min(Math.max(limit, 1), 200)}`, undefined, 'normal');
  }

  /**
   * `GET /v1/verificar/{e2e}` — confirmacao publica de um Pix liquidado pela
   * Lunium (valor, data, instituicao e link do comprovante). 404: nao foi
   * liquidado pela Lunium.
   */
  async verifyE2e(e2e: string): Promise<LuniumE2eVerification | null> {
    if (!/^E[0-9A-Za-z]{32}$/.test(e2e)) return null;
    try {
      return await this.request<LuniumE2eVerification>('GET', `/v1/verificar/${e2e}`);
    } catch (err) {
      if (err instanceof LuniumError && err.statusCode === 404) return null;
      throw err;
    }
  }

  /** `GET /keys/me` — limites vigentes da chave (faixa por operacao e piso por rota). */
  async getKeyInfo(): Promise<unknown> {
    return this.request<unknown>('GET', '/keys/me');
  }

  /** `GET /webhooks/deliveries` — historico das entregas para o motor. */
  async listWebhookDeliveries(input: { status?: 'pending' | 'sent' | 'failed'; limit?: number } = {}) {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(input.limit ?? 50, 1), 200)), ...(input.status ? { status: input.status } : {}) });
    return this.request<{ deliveries?: LuniumWebhookDelivery[]; failed_count?: number }>('GET', `/webhooks/deliveries?${query}`);
  }

  /** `POST /webhooks/deliveries/{event_id}/retry` — reenvia (ganha mais 12 tentativas se falhar). */
  async retryWebhookDelivery(eventId: string) {
    return this.request<{ event_id: string; delivered: boolean; status_code?: number }>(
      'POST',
      `/webhooks/deliveries/${encodeURIComponent(eventId)}/retry`,
    );
  }

  /** `POST /webhooks/test` — dispara um webhook.test agora (6 por minuto). */
  async sendTestWebhook() {
    return this.request<{ ok: boolean; event_id?: string; status_code?: number; ms?: number; url?: string }>('POST', '/webhooks/test');
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
      undefined,
      'normal',
    );
  }

  async findChargesByExternalId(externalId: string): Promise<LuniumCharge[]> {
    const data = await this.request<LuniumChargeList>(
      'GET',
      `/cashin/charges?external_id=${encodeURIComponent(externalId)}`,
      undefined,
      'normal',
    );
    return data.items ?? [];
  }

  /**
   * Limites do pagador. Fica em cache porque muda devagar e é consultado em
   * toda criação de cobrança: sem cache, um pico de cobranças consome o
   * limite de 60 req/min da Lunium só com consultas de limite.
   */
  async getLimits(payerTax: string): Promise<LuniumLimits> {
    return this.limitsCache.wrap(payerTax, () =>
      this.request<LuniumLimits>(
        'GET',
        `/cashin/limits?payer_tax=${encodeURIComponent(payerTax)}`,
        undefined,
        'alta',
      ),
    );
  }

  /** `GET /catalog` — pares de cripto que a Lunium recebe (cache de 5 min). */
  async getCatalog(): Promise<LuniumCatalog> {
    return this.catalogCache.wrap('catalog', () =>
      this.request<LuniumCatalog>('GET', '/catalog', undefined, 'normal'),
    );
  }

  /** `GET /cashin/catalog` — o que a Lunium entrega no cash-in. */
  async getCashinCatalog(): Promise<LuniumCashinCatalog> {
    return this.cashinCatalogCache.wrap('cashin/catalog', () =>
      this.request<LuniumCashinCatalog>(
        'GET',
        '/cashin/catalog',
        undefined,
        'normal',
      ),
    );
  }

  async preview(input: {
    amountCents: bigint;
    asset: 'usdc';
    chain: SettlementChain;
  }): Promise<LuniumPreview> {
    return this.request<LuniumPreview>(
      'POST',
      '/cashin/preview',
      {
        amount_cents: Number(input.amountCents),
        asset: input.asset,
        chain: input.chain,
      },
      'alta',
    );
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
    priority: RateLimitPriority = 'normal',
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const requestId = randomUUID();
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.limiter.acquire(priority);
      } catch (err) {
        throw new LuniumError('fila de chamadas a Lunium cheia', {
          statusCode: 503,
          code: 'lunium_rate_limited',
          detail: err instanceof Error ? err.message : String(err),
          requestId,
        });
      }

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
          this.limiter.recordSuccess();
          return (await response.json()) as T;
        }

        const raw = await response.text().catch(() => '');
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }
        const retryable = isRetryable(response.status, parsed);
        if (response.status === 429) {
          // O provedor recusou por limite: pausa geral e reduz o teto.
          this.limiter.recordThrottled(retryAfterMs(response.headers));
        }
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
        await sleep(backoffMs(attempt, retryAfterMs(response.headers)));
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

/**
 * Corpo das rotas de cash-out.
 *
 * A Lunium trata `br_code` como **mutuamente exclusivo** com `amount`,
 * `brl_amount` e `pix_key` (400 `campos_conflitantes`). O motor valida isso
 * antes (D28) e so envia o que o cliente pediu.
 */
function cashOutBody(input: LuniumCashOutInput): Record<string, unknown> {
  return {
    asset: input.asset,
    network: input.network,
    ...(input.brlAmount ? { brl_amount: input.brlAmount } : {}),
    ...(input.amount ? { amount: input.amount } : {}),
    ...(input.pixKey ? { pix_key: input.pixKey } : {}),
    ...(input.pixKeyType ? { pix_key_type: input.pixKeyType } : {}),
    ...(input.brCode ? { br_code: input.brCode } : {}),
    ...(input.refundAddress ? { refund_address: input.refundAddress } : {}),
    ...(input.externalId ? { external_id: input.externalId } : {}),
    ...(input.sandboxScenario ? { sandbox_scenario: input.sandboxScenario } : {}),
  };
}

/** `retry-after` em segundos (a Lunium envia segundos, não headers HTTP crus). */
function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Espera entre tentativas, respeitando o `retry-after` do provedor. */
function backoffMs(attempt: number, retryAfter?: number): number {
  const base = 250 * 2 ** attempt;
  if (retryAfter !== undefined && retryAfter > 0) {
    return Math.min(retryAfter, 30_000);
  }
  return base;
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

/**
 * Repetir a chamada? A Lunium manda `acao` em todo erro, e ela manda mais
 * que o status HTTP: um 502 `config_provedor` vem com `parar` (repetir nunca
 * resolve), e `corrigir`/`falar_com_suporte` tambem nao melhoram tentando de
 * novo. `repetir` e `esperar` (cota) podem repetir. Sem `acao`, vale o status:
 * 429 e 5xx repetem.
 */
export function isRetryable(status: number, body: Record<string, unknown> | null): boolean {
  const acao = typeof body?.acao === 'string' ? body.acao : null;
  if (acao === 'corrigir' || acao === 'parar' || acao === 'falar_com_suporte') return false;
  if (acao === 'repetir' || acao === 'esperar') return true;
  return status === 429 || status >= 500;
}
