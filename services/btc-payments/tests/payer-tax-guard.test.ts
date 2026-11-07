import { describe, expect, it } from 'vitest';
import { createPayerTaxGuard } from '../src/http/user-routes.js';

/**
 * `/v1/user/payer-limits` usa a chave da Lunium do motor: um cliente nao pode
 * varrer CPFs de terceiros.
 */
describe('teto de CPFs por cliente em payer-limits', () => {
  it('deixa repetir o mesmo CPF, com ou sem pontuacao', () => {
    const allow = createPayerTaxGuard(1);
    expect(allow('c1', '123.456.789-09')).toBe(true);
    expect(allow('c1', '12345678909')).toBe(true);
  });

  it('recusa CPFs distintos acima do teto, por cliente', () => {
    const allow = createPayerTaxGuard(2);
    expect(allow('c1', '11111111111')).toBe(true);
    expect(allow('c1', '22222222222')).toBe(true);
    expect(allow('c1', '33333333333')).toBe(false);
    expect(allow('c2', '33333333333')).toBe(true);
  });

  it('zera no dia seguinte', () => {
    let now = 0;
    const allow = createPayerTaxGuard(1, () => now);
    expect(allow('c1', '11111111111')).toBe(true);
    expect(allow('c1', '22222222222')).toBe(false);
    now += 86_400_000;
    expect(allow('c1', '22222222222')).toBe(true);
  });
});
