import { describe, expect, it } from 'vitest';
import { resolvePaidSats } from '../src/domain/lightning-amount.js';

describe('resolvePaidSats', () => {
  const invoice = 1000n;

  it('trata o numero cru igual a invoice como sats', () => {
    expect(
      resolvePaidSats({ invoiceSats: invoice, rawAmount: 1000, dividedSats: 1 }),
    ).toEqual({ sats: 1000n, unit: 'sats' });
  });

  it('trata o valor dividido igual a invoice como msat', () => {
    expect(
      resolvePaidSats({
        invoiceSats: invoice,
        rawAmount: 1_000_000,
        dividedSats: 1000,
      }),
    ).toEqual({ sats: 1000n, unit: 'msat' });
  });

  it('recusa valor ausente, a menor ou que nao bate', () => {
    expect(resolvePaidSats({ invoiceSats: invoice })).toBeNull();
    expect(resolvePaidSats({ invoiceSats: invoice, dividedSats: 10 })).toBeNull();
    expect(
      resolvePaidSats({ invoiceSats: invoice, rawAmount: 2500, dividedSats: 2 }),
    ).toBeNull();
  });
});
