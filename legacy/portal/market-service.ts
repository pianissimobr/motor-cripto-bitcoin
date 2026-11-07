import type { Logger } from '../logger.js';

/**
 * Precos de mercado so para exibir no portal (grafico). Nao entra em nenhum
 * calculo de cobranca: a conversao R$/US$ -> sats usa o FxService.
 */
export type MarketCoin = {
  id: string;
  symbol: string;
  name: string;
  price_brl: number;
  change_24h_pct: number | null;
  /** Precos em R$ nos ultimos 7 dias, do mais antigo ao mais novo. */
  points: number[];
  /** Instante do primeiro e do ultimo ponto (ISO). */
  from: string;
  to: string;
};

export type MarketSnapshot = {
  source: 'coingecko';
  currency: 'BRL';
  updated_at: string;
  coins: MarketCoin[];
};

export const MARKET_COINS = ['bitcoin', 'ethereum', 'solana', 'usd-coin'] as const;

type CoinGeckoRow = {
  id?: unknown;
  symbol?: unknown;
  name?: unknown;
  current_price?: unknown;
  price_change_percentage_24h?: unknown;
  last_updated?: unknown;
  sparkline_in_7d?: { price?: unknown };
};

export type MarketServiceOptions = {
  logger: Logger;
  url?: string;
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** Reduz a serie para no maximo `max` pontos, mantendo o ultimo. */
export function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values;
  const step = (values.length - 1) / (max - 1);
  const out: number[] = [];
  for (let i = 0; i < max; i += 1) out.push(values[Math.round(i * step)]!);
  return out;
}

export function parseCoinGecko(rows: unknown, now: Date): MarketCoin[] {
  if (!Array.isArray(rows)) throw new Error('resposta do CoinGecko nao e lista');
  const coins: MarketCoin[] = [];
  for (const raw of rows as CoinGeckoRow[]) {
    const price = raw.current_price;
    const series = raw.sparkline_in_7d?.price;
    if (typeof raw.id !== 'string' || typeof price !== 'number' || !Array.isArray(series)) {
      continue;
    }
    const points = downsample(
      series.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
      84,
    );
    if (points.length < 2) continue;
    const to =
      typeof raw.last_updated === 'string' ? new Date(raw.last_updated) : now;
    const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
    coins.push({
      id: raw.id,
      symbol: String(raw.symbol ?? '').toUpperCase(),
      name: String(raw.name ?? raw.id),
      price_brl: price,
      change_24h_pct:
        typeof raw.price_change_percentage_24h === 'number'
          ? raw.price_change_percentage_24h
          : null,
      points,
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }
  // Mesma ordem sempre, independente da resposta.
  coins.sort(
    (a, b) =>
      MARKET_COINS.indexOf(a.id as (typeof MARKET_COINS)[number]) -
      MARKET_COINS.indexOf(b.id as (typeof MARKET_COINS)[number]),
  );
  return coins;
}

export class MarketService {
  private cache: { at: number; data: MarketSnapshot } | null = null;
  private inflight: Promise<MarketSnapshot> | null = null;
  private readonly url: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: MarketServiceOptions) {
    this.url =
      opts.url ??
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=brl' +
        `&ids=${MARKET_COINS.join(',')}&sparkline=true&price_change_percentage=24h`;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Snapshot em cache; se a fonte falhar, devolve o ultimo bom (ou null). */
  async snapshot(): Promise<MarketSnapshot | null> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.data;
    this.inflight ??= this.fetchSnapshot().finally(() => {
      this.inflight = null;
    });
    try {
      const data = await this.inflight;
      this.cache = { at: this.now(), data };
      return data;
    } catch (err) {
      this.opts.logger.warn({ err }, 'mercado indisponivel (grafico do portal)');
      return this.cache?.data ?? null;
    }
  }

  private async fetchSnapshot(): Promise<MarketSnapshot> {
    const res = await this.fetchImpl(this.url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const now = new Date(this.now());
    const coins = parseCoinGecko(await res.json(), now);
    if (coins.length === 0) throw new Error('CoinGecko sem moedas');
    return {
      source: 'coingecko',
      currency: 'BRL',
      updated_at: now.toISOString(),
      coins,
    };
  }
}
