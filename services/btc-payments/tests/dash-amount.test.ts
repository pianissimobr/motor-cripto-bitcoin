import { describe, expect, it } from 'vitest';
import { decimalToCents } from '../src/http/dash-routes.js';

describe('valor decimal -> centavos (links e faturas)', () => {
  it('aceita ponto ou virgula com ate 2 casas', () => {
    expect(decimalToCents('99.90')).toBe(9990n);
    expect(decimalToCents('99,9')).toBe(9990n);
    expect(decimalToCents('10')).toBe(1000n);
    expect(decimalToCents('0.07')).toBe(7n);
  });

  it('recusa zero, negativo, milhar e tres casas', () => {
    for (const bad of ['0', '0.00', '-1', '1.234,56', '1.005', 'abc', '']) {
      expect(() => decimalToCents(bad)).toThrow();
    }
  });
});
