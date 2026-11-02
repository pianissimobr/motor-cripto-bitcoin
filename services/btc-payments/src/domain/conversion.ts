import type { ConversionStatus } from './types.js';

const TRANSITIONS: Record<ConversionStatus, readonly ConversionStatus[]> = {
  criada: ['cotando', 'falhou', 'manual'],
  cotando: ['enviando_btc', 'falhou', 'manual'],
  enviando_btc: ['aguardando_swap', 'falhou', 'manual'],
  aguardando_swap: ['recebendo_usdc', 'reembolsada', 'falhou', 'manual'],
  recebendo_usdc: ['convertida', 'falhou', 'manual'],
  convertida: [],
  falhou: ['cotando', 'manual'],
  reembolsada: [],
  manual: ['cotando', 'falhou'],
};

export class ConversionTransitionError extends Error {
  constructor(
    public readonly from: ConversionStatus,
    public readonly to: ConversionStatus,
  ) {
    super(`transicao de conversao invalida: ${from} -> ${to}`);
    this.name = 'ConversionTransitionError';
  }
}

export function canTransitionConversion(
  from: ConversionStatus,
  to: ConversionStatus,
): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertConversionTransition(
  from: ConversionStatus,
  to: ConversionStatus,
): void {
  if (!canTransitionConversion(from, to)) {
    throw new ConversionTransitionError(from, to);
  }
}
