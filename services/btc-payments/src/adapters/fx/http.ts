import { FxError, parseMarketDecimalToCents } from '../../domain/fx.js';
import type { FxPrice, FxPriceProvider } from '../../services/fx-service.js';

export type HttpFxPriceProviderOptions = {
  coinbaseUrl?: string;
  awesomeApiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Le BTC/USD na Coinbase e USD/BRL na AwesomeAPI. Para BRL, combina os dois
 * precos e devolve o preco de 1 BTC em centavos de BRL.
 */
export class HttpFxPriceProvider implements FxPriceProvider {
  private readonly coinbaseUrl: string;
  private readonly awesomeApiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpFxPriceProviderOptions = {}) {
    this.coinbaseUrl = (
      opts.coinbaseUrl ?? 'https://api.coinbase.com/v2/prices/BTC-USD/spot'
    ).replace(/\/+$/, '');
    this.awesomeApiUrl = (
      opts.awesomeApiUrl ?? 'https://economia.awesomeapi.com.br/json/last/USD-BRL'
    ).replace(/\/+$/, '');
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
      source: 'coinbase+awesomeapi',
      observedAt,
    };
  }

  private async readBtcUsdCents(): Promise<bigint> {
    const data = (await this.getJson(this.coinbaseUrl)) as {
      data?: { amount?: unknown };
    };
    const amount = data.data?.amount;
    if (typeof amount !== 'string') {
      throw new FxError('Coinbase nao retornou o preco do BTC');
    }
    return parseMarketDecimalToCents(amount);
  }

  private async readUsdBrlCents(): Promise<bigint> {
    const data = (await this.getJson(this.awesomeApiUrl)) as {
      USDBRL?: { bid?: unknown };
    };
    const bid = data.USDBRL?.bid;
    if (typeof bid !== 'string') {
      throw new FxError('AwesomeAPI nao retornou USD/BRL');
    }
    return parseMarketDecimalToCents(bid);
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
