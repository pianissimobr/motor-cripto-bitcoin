import type { PaymentIntentStatus } from './types.js';

/**
 * Transicoes permitidas da intent. O estado `falha_criacao` e terminal e
 * existe para a janela em que o indice/endereco foi alocado mas a invoice
 * Lightning nao pode ser criada.
 */
const TRANSITIONS: Record<PaymentIntentStatus, readonly PaymentIntentStatus[]> = {
  criando: ['pendente', 'falha_criacao'],
  pendente: ['pago', 'pago_tardio', 'parcial', 'expirado', 'cancelado'],
  pago: ['reorg'],
  parcial: ['pago_tardio'],
  expirado: ['pago_tardio'],
  pago_tardio: ['reorg'],
  reorg: ['pago', 'pago_tardio'],
  cancelado: [],
  falha_criacao: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: PaymentIntentStatus,
    public readonly to: PaymentIntentStatus,
  ) {
    super(`transicao de status invalida: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isFinalStatus(status: PaymentIntentStatus): boolean {
  return ['pago', 'parcial', 'expirado', 'pago_tardio', 'cancelado', 'falha_criacao'].includes(
    status,
  );
}

export function isPaidStatus(status: PaymentIntentStatus): boolean {
  return status === 'pago' || status === 'pago_tardio';
}
