import { describe, expect, it } from 'vitest';
import { decidePayout } from '../src/domain/payout.js';

describe('payout limits', () => {
  const base = {
    autoPayoutLimitUsdCents: 200_000n,
    dailyVolumeUsdCents: 0n,
    dailyLimitUsdCents: 1_000_000n,
    newWallet: false,
  };

  it('paga automatico abaixo do limite', () => {
    expect(decidePayout({ ...base, amountUsdCents: 150_000n })).toBe('automatico');
  });

  it('exige aprovacao acima do limite automatico', () => {
    expect(decidePayout({ ...base, amountUsdCents: 200_001n })).toBe(
      'aprovacao_manual',
    );
  });

  it('retem carteira nova', () => {
    expect(decidePayout({ ...base, newWallet: true, amountUsdCents: 1_000n })).toBe(
      'retido',
    );
  });

  it('retem quando o limite diario seria excedido', () => {
    expect(
      decidePayout({
        ...base,
        dailyVolumeUsdCents: 950_000n,
        amountUsdCents: 100_000n,
      }),
    ).toBe('retido');
  });
});

import {
  assertPayoutTransition,
  brlCentsToUsdCents,
  canTransitionPayout,
  usdCentsToUsdcMinor,
  usdcMinorToUsdCents,
} from '../src/domain/payout.js';

describe('payout state and units', () => {
  it('permite caminho feliz e bloqueia estado terminal', () => {
    expect(canTransitionPayout('pendente', 'aprovado')).toBe(true);
    expect(canTransitionPayout('aprovado', 'enviando')).toBe(true);
    expect(canTransitionPayout('enviando', 'confirmado')).toBe(true);
    expect(() => assertPayoutTransition('confirmado', 'enviando')).toThrow();
  });

  it('converte USDC minor para centavos USD', () => {
    expect(usdcMinorToUsdCents(1_000_000n)).toBe(100n);
    expect(usdCentsToUsdcMinor(100n)).toBe(1_000_000n);
    expect(brlCentsToUsdCents(1_000_000n, 540n)).toBe(185_185n);
  });
});
