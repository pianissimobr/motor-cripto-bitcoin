import { describe, expect, it } from 'vitest';
import {
  assertConversionTransition,
  canTransitionConversion,
  ConversionTransitionError,
} from '../src/domain/conversion.js';

describe('conversion state', () => {
  it('permite caminho feliz', () => {
    expect(canTransitionConversion('criada', 'cotando')).toBe(true);
    expect(canTransitionConversion('cotando', 'enviando_btc')).toBe(true);
    expect(canTransitionConversion('enviando_btc', 'aguardando_swap')).toBe(true);
    expect(canTransitionConversion('aguardando_swap', 'recebendo_usdc')).toBe(true);
    expect(canTransitionConversion('recebendo_usdc', 'convertida')).toBe(true);
  });

  it('rejeita transicao invalida', () => {
    expect(() => assertConversionTransition('convertida', 'falhou')).toThrow(
      ConversionTransitionError,
    );
    expect(canTransitionConversion('manual', 'convertida')).toBe(false);
  });
});
