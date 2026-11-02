import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { fxQuotes } from '../db/schema.js';
import {
  fiatCentsToSats,
  FxError,
  satsPerFiatUnit,
} from '../domain/fx.js';
import type { FxQuote } from '../domain/types.js';

export type FxPrice = {
  currency: 'BRL' | 'USD';
  btcPriceCents: bigint;
  source: string;
  observedAt: Date;
};

export interface FxPriceProvider {
  getBtcPrice(currency: 'BRL' | 'USD'): Promise<FxPrice>;
}

export class FixedFxPriceProvider implements FxPriceProvider {
  constructor(private readonly prices: Partial<Record<'BRL' | 'USD', bigint>>) {}

  async getBtcPrice(currency: 'BRL' | 'USD'): Promise<FxPrice> {
    const price = this.prices[currency];
    if (price === undefined || price <= 0n) {
      throw new FxError(`preco BTC/${currency} indisponivel`);
    }
    return {
      currency,
      btcPriceCents: price,
      source: 'fixed',
      observedAt: new Date(),
    };
  }
}

export type FxRateSnapshot = {
  currency: 'BRL' | 'USD';
  btcPriceCents: bigint;
  source: string;
  observedAt: Date;
};

export type CreateFxQuoteInput = {
  merchantId: string;
  amountFiatCents: bigint;
  currency: 'BRL' | 'USD';
  spreadBps: number;
  ttlSeconds: number;
};

export class FxService {
  constructor(
    private readonly db: Db,
    private readonly provider: FxPriceProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createQuote(input: CreateFxQuoteInput): Promise<FxQuote> {
    if (input.amountFiatCents <= 0n) throw new FxError('valor fiat invalido');
    if (!Number.isInteger(input.spreadBps) || input.spreadBps < 0) {
      throw new FxError('spread invalido');
    }
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 30) {
      throw new FxError('ttl da cotacao invalido');
    }

    const price = await this.provider.getBtcPrice(input.currency);
    const amountSats = fiatCentsToSats({
      amountFiatCents: input.amountFiatCents,
      btcPriceCents: price.btcPriceCents,
      spreadBps: input.spreadBps,
    });
    const rate = satsPerFiatUnit({
      amountSats,
      amountFiatCents: input.amountFiatCents,
    });
    const now = this.now();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);

    const rows = await this.db
      .insert(fxQuotes)
      .values({
        merchantId: input.merchantId,
        baseCurrency: input.currency,
        quoteAsset: 'BTC',
        amountIn: input.amountFiatCents,
        amountOut: amountSats,
        rate,
        spreadBps: input.spreadBps,
        source: price.source,
        expiresAt,
        status: 'ativa',
      })
      .returning();
    const quote = rows[0];
    if (!quote) throw new FxError('falha ao criar cotacao');
    return quote;
  }

  async getRates(): Promise<FxRateSnapshot[]> {
    const [brl, usd] = await Promise.all([
      this.provider.getBtcPrice('BRL'),
      this.provider.getBtcPrice('USD'),
    ]);
    return [brl, usd];
  }

  async getQuote(id: string): Promise<FxQuote | null> {
    const rows = await this.db.select().from(fxQuotes).where(eq(fxQuotes.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async markUsed(id: string): Promise<void> {
    await this.db.update(fxQuotes).set({ status: 'usada' }).where(eq(fxQuotes.id, id));
  }
}
