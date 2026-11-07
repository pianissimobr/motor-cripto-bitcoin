import { FxError, parseMarketDecimalToCents } from '../../domain/fx.js';
import type { FxPrice, FxPriceProvider } from '../../services/fx-service.js';

export type HttpFxPriceProviderOptions = {
  coinbaseUrl?: string;
  awesomeApiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Fonte de preco: uma URL e o jeito de ler o numero dela.
 *
 * Cada fonte tem o seu formato, e cada uma falha sozinha: a API da AwesomeAPI
 * responde 429 com frequencia e a do Coinbase ja falhou com 5xx. A cotacao nao
 * pode depender de uma so.
 */
type FxSource = {
  url: string;
  parse: (payload: unknown) => string | null;
};

const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const BTC_USD_SOURCES: FxSource[] = [
  {
    url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
    parse: (payload) => {
      const data = (payload as { data?: { amount?: unknown } })?.data;
      return asString(data?.amount);
    },
  },
  {
    url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    parse: (payload) => asString((payload as { last?: unknown })?.last),
  },
  {
    url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    parse: (payload) => {
      const result = (payload as { result?: Record<string, { c?: unknown }> })?.result;
      const first = result ? Object.values(result)[0] : undefined;
      const close = first?.c;
      return Array.isArray(close) ? asString(close[0]) : null;
    },
  },
  {
    url: 'https://blockchain.info/ticker?base=BTC&currency=USD',
    parse: (payload) => {
      const ticker = (payload as { USD?: { last?: unknown } })?.USD;
      return asString(ticker?.last);
    },
  },
];

const USD_BRL_SOURCES: FxSource[] = [
  {
    url: 'https://economia.awesomeapi.com.br/json/last/USD-BRL',
    parse: (payload) => asString((payload as { USDBRL?: { bid?: unknown } })?.USDBRL?.bid),
  },
  {
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (payload) => {
      const rates = (payload as { rates?: { BRL?: unknown } })?.rates;
      return asString(rates?.BRL);
    },
  },
];

/**
 * Le BTC/USD e USD/BRL de varias fontes.
 *
 * A primeira fonte que responder ganha. A cota e das fontes publicas: e
 * por isso que o preco tambem fica em cache (ver `CachedFxPriceProvider`).
 */
export class HttpFxPriceProvider implements FxPriceProvider {
  private readonly btcUsdSources: FxSource[];
  private readonly usdBrlSources: FxSource[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpFxPriceProviderOptions = {}) {
    this.btcUsdSources = [
      {
        url: opts.coinbaseUrl ?? BTC_USD_SOURCES[0]!.url,
        parse: BTC_USD_SOURCES[0]!.parse,
      },
      ...BTC_USD_SOURCES.slice(1),
    ];
    this.usdBrlSources = [
      {
        url: opts.awesomeApiUrl ?? USD_BRL_SOURCES[0]!.url,
        parse: USD_BRL_SOURCES[0]!.parse,
      },
      ...USD_BRL_SOURCES.slice(1),
    ];
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getBtcPrice(currency: 'BRL' | 'USD'): Promise<FxPrice> {
    const observedAt = new Date();
    const btcUsdCents = await this.readBtcUsdCents();

    if (currency === 'USD') {
      return {
        currency,
        btcPriceCents: btcUsdCents,
        source: 'coinbase',
        observedAt,
      };
    }

    const usdBrlCents = await this.readUsdBrlCents();
    return {
      currency,
      btcPriceCents: (btcUsdCents * usdBrlCents) / 100n,
      source: 'multi',
      observedAt,
    };
  }

  private async readBtcUsdCents(): Promise<bigint> {
    const value = await this.readFirst(BTC_USD_SOURCES);
    return parseMarketDecimalToCents(value);
  }

  private async readUsdBrlCents(): Promise<bigint> {
    const value = await this.readFirst(USD_BRL_SOURCES);
    return parseMarketDecimalToCents(value);
  }

  /** Le a primeira fonte que responder com um numero. */
  private async readFirst(sources: FxSource[]): Promise<string> {
    let lastError: unknown = null;
    for (const source of sources) {
      try {
        const payload = await this.getJson(source.url);
        const value = source.parse(payload);
        if (value) return value;
        lastError = new FxError(`fonte de taxa ${source.url} nao retornou o preco`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof FxError
      ? lastError
      : new FxError('nenhuma fonte de taxa disponivel');
  }

  private async getJson(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new FxError(`falha ao buscar taxa em ${url}`, { cause: err });
    }
    if (!response.ok) {
      throw new FxError(`fonte de taxa respondeu HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch (err) {
      throw new FxError('fonte de taxa retornou JSON invalido', { cause: err });
    }
  }
}

export class FallbackFxPriceProvider implements FxPriceProvider {
  constructor(private readonly providers: FxPriceProvider[]) {}

  async getBtcPrice(currency: 'BRL' | 'USD'): Promise<FxPrice> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        return await provider.getBtcPrice(currency);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new FxError(`nenhuma fonte de taxa disponivel para ${currency}`);
  }
}

/**
 * Cache curto do preco.
 *
 * As fontes de taxa sao publicas e tem cota propria: uma rajada de cobrancas
 * nao pode virar uma rajada de requisicoes (e o 429 derruba a criacao do
 * pedido inteiro).
 */
export class CachedFxPriceProvider implements FxPriceProvider {
  private readonly cache = new Map<'BRL' | 'USD', { price: FxPrice; expiresAt: number }>();

  constructor(
    private readonly provider: FxPriceProvider,
    private readonly ttlMs: number = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getBtcPrice(currency: 'BRL' | 'USD'): Promise<FxPrice> {
    const cached = this.cache.get(currency);
    if (cached && cached.expiresAt > this.now()) {
      return cached.price;
    }
    const price = await this.provider.getBtcPrice(currency);
    this.cache.set(currency, { price, expiresAt: this.now() + this.ttlMs });
    return price;
  }
}
