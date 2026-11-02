import { describe, expect, it } from 'vitest';
import {
  baseUnitsToDecimal,
  centsToFiat,
  centsToUnits,
  decimalToBaseUnits,
  divRound,
  fiatToCents,
  unitsToCents,
  withinTolerance,
} from '../src/core/domain/money.js';

describe('fiatToCents', () => {
  it('aceita virgula e ponto', () => {
    expect(fiatToCents('150,00')).toBe(15_000);
    expect(fiatToCents('150.00')).toBe(15_000);
    expect(fiatToCents('0,01')).toBe(1);
    // 0.29 * 100 em float da 28.999...; a conversao inteira da 29.
    expect(fiatToCents('0,29')).toBe(29);
    expect(fiatToCents(0.29)).toBe(29);
  });

  it('rejeita valores invalidos', () => {
    expect(() => fiatToCents('abc')).toThrow();
    expect(() => fiatToCents('1.234')).toThrow();
    expect(() => fiatToCents('-10')).toThrow();
  });
});

describe('centsToFiat', () => {
  it('formata no padrao brasileiro', () => {
    expect(centsToFiat(15_000)).toBe('150,00');
    expect(centsToFiat(5)).toBe('0,05');
  });
});

describe('conversao fiat <-> unidades ISO-4217', () => {
  it('usa unidades minimas (a Ramp converte "10.00" EUR em "1000")', () => {
    expect(unitsToCents('15000')).toBe(15_000);
    expect(centsToUnits(15_000)).toBe('15000');
  });

  it('faz round-trip', () => {
    for (const cents of [0, 1, 99, 15_000, 123_456]) {
      expect(unitsToCents(centsToUnits(cents))).toBe(cents);
    }
  });
});

describe('base units do token', () => {
  it('converte base units para decimal sem float', () => {
    expect(baseUnitsToDecimal(1_000_000n, 6)).toBe('1');
    expect(baseUnitsToDecimal(22_221_000n, 6)).toBe('22.221');
    expect(baseUnitsToDecimal(1n, 6)).toBe('0.000001');
    expect(baseUnitsToDecimal(0n, 6)).toBe('0');
  });

  it('converte decimal para base units', () => {
    expect(decimalToBaseUnits('1', 6)).toBe(1_000_000n);
    expect(decimalToBaseUnits('22.221', 6)).toBe(22_221_000n);
    expect(decimalToBaseUnits('0.000001', 6)).toBe(1n);
  });

  it('rejeita mais casas decimais que o token suporta', () => {
    expect(() => decimalToBaseUnits('1.0000001', 6)).toThrow();
  });

  it('faz round-trip decimal -> base units -> decimal', () => {
    for (const value of ['1', '22.221', '0.5', '1500.000001']) {
      expect(baseUnitsToDecimal(decimalToBaseUnits(value, 6), 6)).toBe(value);
    }
  });
});

describe('tolerancia', () => {
  it('aceita dentro da tolerancia', () => {
    expect(withinTolerance(1_000_000n, 1_000_000n, 1)).toBe(true);
    expect(withinTolerance(1_000_000n, 995_000n, 1)).toBe(true);
  });

  it('rejeita fora da tolerancia', () => {
    expect(withinTolerance(1_000_000n, 900_000n, 1)).toBe(false);
  });

  it('aceita pagamento a maior', () => {
    expect(withinTolerance(1_000_000n, 1_100_000n, 1)).toBe(false);
    expect(withinTolerance(1_000_000n, 1_005_000n, 1)).toBe(true);
  });
});

describe('divRound', () => {
  it('arredonda para o mais proximo sem float', () => {
    expect(divRound(10n, 3n)).toBe(3n);
    expect(divRound(11n, 3n)).toBe(4n);
    expect(divRound(-10n, 3n)).toBe(-3n);
  });
});
