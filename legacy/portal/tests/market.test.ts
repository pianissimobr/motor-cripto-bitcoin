import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { MarketService, downsample, parseCoinGecko } from '../src/services/market-service.js';

const row = (id: string, price: number) => ({
  id,
  symbol: id.slice(0, 3),
  name: id,
  current_price: price,
  price_change_percentage_24h: -1.5,
  last_updated: '2026-11-02T12:00:00.000Z',
  sparkline_in_7d: { price: Array.from({ length: 168 }, (_, i) => price + i) },
});

describe('market', () => {
  it('reduz a serie mantendo primeiro e ultimo ponto', () => {
    const out = downsample(Array.from({ length: 168 }, (_, i) => i), 84);
    expect(out).toHaveLength(84);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(167);
  });

  it('le o CoinGecko na ordem fixa e ignora linhas quebradas', () => {
    const coins = parseCoinGecko(
      [row('solana', 900), { id: 'quebrada' }, row('bitcoin', 500_000)],
      new Date(),
    );
    expect(coins.map((c) => c.id)).toEqual(['bitcoin', 'solana']);
    expect(coins[0]!.symbol).toBe('BIT');
    expect(coins[0]!.points).toHaveLength(84);
    expect(coins[0]!.to).toBe('2026-11-02T12:00:00.000Z');
  });

  it('usa cache e devolve o ultimo bom quando a fonte cai', async () => {
    let calls = 0;
    let fail = false;
    let now = 0;
    const market = new MarketService({
      logger: silentLogger,
      now: () => now,
      fetchImpl: (async () => {
        calls += 1;
        if (fail) throw new Error('fora do ar');
        return new Response(JSON.stringify([row('bitcoin', 1)]));
      }) as typeof fetch,
    });
    expect((await market.snapshot())?.coins).toHaveLength(1);
    await market.snapshot();
    expect(calls).toBe(1);
    now = 10 * 60_000;
    fail = true;
    expect((await market.snapshot())?.coins).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
