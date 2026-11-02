import { describe, expect, it } from 'vitest';
import {
  fiatCentsToSats,
  FxError,
  parseFiatToCents,
  parseMarketDecimalToCents,
  parseRateToScaled,
  satsPerFiatUnit,
} from '../src/domain/fx.js';

describe('fx', () => {
  it('converte fiat para sats com spread', () => {
    expect(
      fiatCentsToSats({
        amountFiatCents: 10_000n,
        btcPriceCents: 50_000_000n,
        spreadBps: 0,
      }),
    ).toBe(20_000n);

    expect(
      fiatCentsToSats({
        amountFiatCents: 10_000n,
        btcPriceCents: 50_000_000n,
        spreadBps: 100,
      }),
    ).toBe(20_200n);
  });

  it('calcula sats por unidade fiat com 18 casas', () => {
    expect(satsPerFiatUnit({ amountSats: 20_000n, amountFiatCents: 10_000n })).toBe(
      '200.000000000000000000',
    );
  });

  it('rejeita valores invalidos', () => {
    expect(() =>
      fiatCentsToSats({ amountFiatCents: 0n, btcPriceCents: 1n, spreadBps: 0 }),
    ).toThrow(FxError);
    expect(() =>
      fiatCentsToSats({ amountFiatCents: 1n, btcPriceCents: 0n, spreadBps: 0 }),
    ).toThrow(FxError);
    expect(() =>
      fiatCentsToSats({ amountFiatCents: 1n, btcPriceCents: 1n, spreadBps: -1 }),
    ).toThrow(FxError);
  });

  it('parseia taxa decimal para escala inteira', () => {
    expect(parseRateToScaled('200.5', 2)).toBe(20_050n);
    expect(() => parseRateToScaled('-1')).toThrow(FxError);
  });
});

describe('fx parse', () => {
  it('parseia fiat para centavos', () => {
    expect(parseFiatToCents('100.00')).toBe(10_000n);
    expect(parseFiatToCents('100.5')).toBe(10_050n);
    expect(parseFiatToCents(100)).toBe(10_000n);
  });

  it('parseia decimal de mercado truncando centavos', () => {
    expect(parseMarketDecimalToCents('60000.1299')).toBe(6_000_012n);
    expect(() => parseMarketDecimalToCents('abc')).toThrow(FxError);
  });
});
