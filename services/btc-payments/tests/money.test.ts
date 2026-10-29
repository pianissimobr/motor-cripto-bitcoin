import { describe, expect, it } from 'vitest';
import {
  btcToSats,
  MAX_SATS,
  MoneyError,
  parseSats,
  satsToBtc,
} from '../src/domain/money.js';

describe('money', () => {
  it('converte sats para BTC com 8 casas', () => {
    expect(satsToBtc(0n)).toBe('0.00000000');
    expect(satsToBtc(1n)).toBe('0.00000001');
    expect(satsToBtc(10_000n)).toBe('0.00010000');
    expect(satsToBtc(100_000_000n)).toBe('1.00000000');
  });

  it('converte BTC decimal para sats sem float', () => {
    expect(btcToSats('0.0001')).toBe(10_000n);
    expect(btcToSats('1')).toBe(100_000_000n);
    expect(btcToSats('1.00000001')).toBe(100_000_001n);
  });

  it('rejeita BTC com mais de 8 casas ou sinal', () => {
    expect(() => btcToSats('0.000000001')).toThrow(MoneyError);
    expect(() => btcToSats('-1')).toThrow(MoneyError);
  });

  it('parseia sats de string, number e bigint', () => {
    expect(parseSats('10000')).toBe(10_000n);
    expect(parseSats(10_000)).toBe(10_000n);
    expect(parseSats(10_000n)).toBe(10_000n);
  });

  it('rejeita float, negativo e acima do limite', () => {
    expect(() => parseSats(1.5)).toThrow(MoneyError);
    expect(() => parseSats('-1')).toThrow(MoneyError);
    expect(() => parseSats(MAX_SATS + 1n)).toThrow(MoneyError);
  });
});
