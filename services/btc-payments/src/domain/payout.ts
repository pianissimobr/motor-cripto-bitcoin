export type PayoutDecision = 'automatico' | 'aprovacao_manual' | 'retido';

export type PayoutDecisionInput = {
  amountUsdCents: bigint;
  autoPayoutLimitUsdCents: bigint;
  dailyVolumeUsdCents: bigint;
  dailyLimitUsdCents: bigint;
  newWallet: boolean;
};

/**
 * Decide o caminho do payout em unidades menores de USD.
 * Carteira nova fica retida; acima do limite automatico exige aprovacao.
 */
export function decidePayout(input: PayoutDecisionInput): PayoutDecision {
  if (input.amountUsdCents <= 0n) {
    throw new Error('valor do payout precisa ser positivo');
  }
  if (input.newWallet) return 'retido';
  if (input.amountUsdCents > input.autoPayoutLimitUsdCents) {
    return 'aprovacao_manual';
  }
  if (input.dailyVolumeUsdCents + input.amountUsdCents > input.dailyLimitUsdCents) {
    return 'retido';
  }
  return 'automatico';
}

import type { PayoutStatus } from './types.js';

const PAYOUT_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  pendente: ['aprovado', 'retido', 'cancelado', 'falhou'],
  retido: ['aprovado', 'pendente', 'cancelado', 'falhou'],
  aprovado: ['enviando', 'retido', 'cancelado', 'falhou'],
  enviando: ['confirmado', 'falhou'],
  falhou: ['aprovado', 'pendente', 'retido', 'cancelado'],
  confirmado: [],
  cancelado: [],
};

export class PayoutTransitionError extends Error {
  constructor(
    public readonly from: PayoutStatus,
    public readonly to: PayoutStatus,
  ) {
    super(`transicao de payout invalida: ${from} -> ${to}`);
    this.name = 'PayoutTransitionError';
  }
}

export function canTransitionPayout(
  from: PayoutStatus,
  to: PayoutStatus,
): boolean {
  if (from === to) return true;
  return PAYOUT_TRANSITIONS[from].includes(to);
}

export function assertPayoutTransition(
  from: PayoutStatus,
  to: PayoutStatus,
): void {
  if (!canTransitionPayout(from, to)) {
    throw new PayoutTransitionError(from, to);
  }
}

/** USDC tem 6 casas; USD centavo tem 2. */
export const USDC_MINOR_PER_USD_CENT = 10_000n;

export function usdcMinorToUsdCents(amountMinor: bigint): bigint {
  if (amountMinor <= 0n) throw new Error('valor USDC precisa ser positivo');
  return amountMinor / USDC_MINOR_PER_USD_CENT;
}

export function usdCentsToUsdcMinor(amountUsdCents: bigint): bigint {
  if (amountUsdCents <= 0n) throw new Error('valor USD precisa ser positivo');
  return amountUsdCents * USDC_MINOR_PER_USD_CENT;
}

/** Converte centavos de BRL para centavos de USD usando BRL por USD. */
export function brlCentsToUsdCents(
  brlCents: bigint,
  usdBrlCents: bigint,
): bigint {
  if (brlCents <= 0n || usdBrlCents <= 0n) {
    throw new Error('valores de cambio precisam ser positivos');
  }
  return (brlCents * 100n) / usdBrlCents;
}
