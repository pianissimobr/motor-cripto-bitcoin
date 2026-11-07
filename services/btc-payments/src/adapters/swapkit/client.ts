import { randomUUID } from 'node:crypto';
import {
  RateLimiter,
  type RateLimitPriority,
} from '../../net/rate-limiter.js';

/**
 * Adapter da SwapKit (https://api.swapkit.dev).
 *
 * A SwapKit e um agregador de swap. Aqui ela faz o papel de **trilho de
 * pagamento em Bitcoin**: o pagador envia BTC para um endereco de deposito e a
 * SwapKit troca por USDC na Polygon, entregando na carteira do cliente.
 *
 * Duas coisas moldaram este adapter:
 *
 * - **O endereco de deposito precisa ser unico por cobranca.** E o que permite
 *   usar um BIP21 comum (`bitcoin:endereco?amount=...`): a THORChain, que
 *   compartilha um cofre e identifica o pedido pelo memo (OP_RETURN), nao
 *   caberia num QR de endereco. Os provedores de deposito (NEAR, FLASHNET) dao
 *   um endereco por pedido.
 * - **Nao ha webhook no fluxo comum.** O estado so vem por `POST /track`, com o
 *   `depositAddress` ou o `depositChannelId`. O worker do motor reconcilia.
 *
 * A documentacao nao diz se o `sellAmount` e em unidade base (sats) ou
 * decimal (BTC). A opcao `amountUnit` deixa isso explicito no `.env`: o
 * default segue os exemplos da documentacao (decimal) e o spike com chave real
 * confirma.
 */

export type SwapKitAmountUnit = 'decimal' | 'base';

export type SwapKitFee = {
  type?: string | null;
  amount?: string | null;
  amountBps?: number | null;
  asset?: string | null;
  chain?: string | null;
  protocol?: string | null;
};

export type SwapKitEstimatedTime = {
  inbound?: number | null;
  swap?: number | null;
  outbound?: number | null;
  total?: number | null;
};

export type SwapKitProviderError = {
  provider?: string | null;
  errorCode?: string | null;
  message?: string | null;
  /** Minimo do provedor, em unidade legivel do ativo vendido. */
  minAmount?: string | null;
};

export type SwapKitQuoteRoute = {
  routeId: string;
  providers?: string[] | null;
  sellAsset?: string | null;
  sellAmount?: string | null;
  buyAsset?: string | null;
  buyAmount?: string | null;
  fees?: SwapKitFee[] | null;
  estimatedTime?: SwapKitEstimatedTime | null;
  totalSlippageBps?: number | null;
  warnings?: string[] | null;
  legs?: unknown[] | null;
};

export type SwapKitQuote = {
  quoteId?: string | null;
  createdAt?: string | null;
  routes?: SwapKitQuoteRoute[] | null;
  providerErrors?: SwapKitProviderError[] | null;
};

export type SwapKitSwapMeta = {
  providerDepositChannelId?: string | null;
  /** Prazo do deposito, em unix (segundos). */
  depositChannelExpiration?: number | null;
  depositChannelExpirationBlock?: number | null;
  /** Endereco de deposito unico do pedido (provedores de deposito). */
  depositAddress?: string | null;
};

export type SwapKitSwap = {
  swapId?: string | null;
  routeId?: string | null;
  txType?: string | null;
  inboundAddress?: string | null;
  memo?: string | null;
  txHint?: string | null;
  targetAddress?: string | null;
  /** Quanto o pagador envia e quanto o cliente recebe. */
  sellAmount?: string | null;
  buyAmount?: string | null;
  meta?: SwapKitSwapMeta | null;
  tx?: string | null;
  fees?: SwapKitFee[] | null;
  estimatedTime?: SwapKitEstimatedTime | null;
};

export type SwapKitTrack = {
  status?: string | null;
  swapId?: string | null;
  routeId?: string | null;
  provider?: string | null;
  depositAddress?: string | null;
  depositChannelId?: string | null;
  hash?: string | null;
  chainId?: string | null;
  sellAmount?: string | null;
  buyAmount?: string | null;
  fees?: SwapKitFee[] | null;
  error?: string | null;
  failureReason?: string | null;
  refundAddress?: string | null;
  [key: string]: unknown;
};

export type SwapKitProvider = {
  name?: string | null;
  enabledChainIds?: string[] | null;
  [key: string]: unknown;
};

export class SwapKitError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly detail: string | null;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: string;
      requestId?: string | null;
      detail?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'SwapKitError';
    this.statusCode = options.statusCode ?? 502;
    this.code = options.code ?? 'swapkit_error';
    this.requestId = options.requestId ?? null;
    this.detail = options.detail ?? null;
  }
}

export function isSwapKitError(value: unknown): value is SwapKitError {
  return value instanceof SwapKitError;
}

export type SwapKitClientOptions = {
  apiUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  rateLimit?: {
    maxRequests?: number;
    windowMs?: number;
    maxQueue?: number;
  };
};

type ErrorBody = {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  data?: unknown;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function backoffMs(attempt: number, retryAfter?: number): number {
  const base = 250 * 2 ** attempt;
  if (retryAfter !== undefined && retryAfter > 0) {
    return Math.min(retryAfter, 30_000);
  }
  return base;
}

/**
 * Converte sats na unidade que a API espera.
 *
 * `decimal` e o formato dos exemplos da documentacao (`0.01` para um BTC);
 * `base` e o numero de sats. A escolha fica no `.env` porque a documentacao
 * nao deixa claro qual dos dois o `/v3/quote` espera.
 */
export function formatBtcAmount(
  sats: bigint,
  unit: SwapKitAmountUnit = 'decimal',
): string {
  if (unit === 'base') return sats.toString();
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  const value = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${value}` : value;
}

/** Converte o `buyAmount` da SwapKit (USDC, 6 decimais) para unidades minimas. */
export function usdcToMinor(amount: string | null | undefined): bigint | null {
  if (amount === null || amount === undefined) return null;
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const padded = (frac + '000000').slice(0, 6);
  return BigInt(whole!) * 1_000_000n + BigInt(padded || '0');
}

export class SwapKitClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;

  constructor(options: SwapKitClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limiter = new RateLimiter({
      maxRequests: options.rateLimit?.maxRequests ?? 10,
      windowMs: options.rateLimit?.windowMs ?? 60_000,
      ...(options.rateLimit?.maxQueue !== undefined
        ? { maxQueue: options.rateLimit.maxQueue }
        : {}),
    });
  }

  get rateLimiter(): RateLimiter {
    return this.limiter;
  }

  /** `GET /providers` — os provedores e as chains que a chave pode usar. */
  async providers(): Promise<SwapKitProvider[]> {
    const data = await this.request<unknown>('GET', '/providers');
    if (Array.isArray(data)) return data as SwapKitProvider[];
    if (data && typeof data === 'object') {
      const providers = (data as { providers?: unknown }).providers;
      if (Array.isArray(providers)) return providers as SwapKitProvider[];
    }
    return [];
  }

  /**
   * `POST /v3/quote` — precificacao.
   *
   * A cotacao vale por 5 minutos: depois disso a rota some (`swapRouteNotFound`).
   */
  async quote(input: {
    sellAsset: string;
    buyAsset: string;
    sellAmount: string;
    destinationAddress: string;
    providers?: string[];
    slippageBps?: number;
  }): Promise<SwapKitQuote> {
    return this.request<SwapKitQuote>('POST', '/v3/quote', {
      sellAsset: input.sellAsset,
      buyAsset: input.buyAsset,
      sellAmount: input.sellAmount,
      destinationAddress: input.destinationAddress,
      ...(input.providers && input.providers.length > 0
        ? { providers: input.providers }
        : {}),
      ...(input.slippageBps !== undefined ? { slippage: input.slippageBps } : {}),
    });
  }

  /**
   * `POST /v3/swap` — transforma a rota em um deposito.
   *
   * O que interessa aqui e o `meta.depositAddress` (o endereco unico do
   * pedido) e o `meta.depositChannelExpiration` (o prazo). O `tx` devolvido
   * e um PSBT que **nao** usamos: no trilho de pagamento quem paga e o
   * pagador, nao o motor.
   */
  async swap(input: {
    routeId: string;
    sourceAddress?: string;
    destinationAddress: string;
  }): Promise<SwapKitSwap> {
    return this.request<SwapKitSwap>('POST', '/v3/swap', {
      routeId: input.routeId,
      destinationAddress: input.destinationAddress,
      ...(input.sourceAddress ? { sourceAddress: input.sourceAddress } : {}),
    });
  }

  /**
   * `POST /track` — estado do swap.
   *
   * Aceita `depositChannelId` ou `depositAddress` (e nao o hash, porque no
   * trilho de deposito o motor nao tem a transacao: quem tem e o pagador).
   */
  async track(input: {
    depositChannelId?: string | null;
    depositAddress?: string | null;
    hash?: string | null;
    chainId?: string | null;
  }): Promise<SwapKitTrack> {
    return this.request<SwapKitTrack>('POST', '/track', {
      ...(input.depositChannelId ? { depositChannelId: input.depositChannelId } : {}),
      ...(input.depositAddress ? { depositAddress: input.depositAddress } : {}),
      ...(input.hash ? { hash: input.hash } : {}),
      ...(input.chainId ? { chainId: input.chainId } : {}),
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.providers();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
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
        throw new SwapKitError('fila de chamadas a SwapKit cheia', {
          statusCode: 503,
          code: 'swapkit_rate_limited',
          requestId,
          cause: err,
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
        let parsed: ErrorBody | null = null;
        try {
          parsed = raw ? (JSON.parse(raw) as ErrorBody) : null;
        } catch {
          parsed = null;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (response.status === 429) {
          this.limiter.recordThrottled(retryAfterMs(response.headers));
        }
        const error = new SwapKitError(
          typeof parsed?.message === 'string'
            ? parsed.message
            : `SwapKit respondeu HTTP ${response.status}`,
          {
            statusCode: response.status,
            code:
              typeof parsed?.error === 'string'
                ? parsed.error
                : typeof parsed?.code === 'string'
                  ? parsed.code
                  : 'swapkit_error',
            requestId,
            detail: raw,
          },
        );
        lastError = error;
        if (!retryable || attempt === 2) throw error;
        await sleep(backoffMs(attempt, retryAfterMs(response.headers)));
      } catch (err) {
        if (err instanceof SwapKitError) throw err;
        lastError = err;
        if (attempt === 2) {
          throw new SwapKitError('falha de rede ao chamar a SwapKit', {
            statusCode: 503,
            code: 'swapkit_network_error',
            requestId,
            detail: err instanceof Error ? err.message : String(err),
            cause: err,
          });
        }
        await sleep(backoffMs(attempt));
      }
    }

    throw lastError instanceof SwapKitError
      ? lastError
      : new SwapKitError('falha ao chamar a SwapKit', { cause: lastError });
  }
}
