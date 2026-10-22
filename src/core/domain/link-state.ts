/**
 * A4: tabela de transicoes de status do link.
 *
 * Antes, `updateStatus` era uma escrita cega: qualquer estado podia ir
 * para qualquer estado. Isso mascarava bugs (um link 'movido' voltando
 * para 'pago' sem explicacao, por exemplo) e nao deixava rastro do motivo.
 *
 * Regra de ouro do motor: **nunca recusar dinheiro que chegou**.
 * Pagamento fora do prazo ou em link revogado e creditado, mas o link
 * precisa de uma transicao explicita para isso.
 */

import type { LinkStatus } from './types.js';

export const LINK_TRANSITIONS: Record<LinkStatus, readonly LinkStatus[]> = {
  aguardando: ['pago', 'parcial', 'pago_sem_gas', 'expirado', 'revogado'],
  pago: ['parcial', 'movido', 'pago_sem_gas', 'expirado', 'revogado'],
  parcial: ['pago', 'movido', 'pago_sem_gas', 'expirado', 'revogado'],
  pago_sem_gas: ['pago', 'parcial', 'movido', 'expirado', 'revogado'],
  // 'movido' so volta atras por reorg ou reconciliacao (A5).
  movido: ['pago', 'parcial'],
  // pagamento fora do prazo: o dinheiro chegou, entao entra.
  expirado: ['pago', 'parcial', 'revogado'],
  // link revogado mas o dinheiro apareceu assim mesmo.
  revogado: ['pago', 'parcial'],
};

export function canTransition(from: LinkStatus, to: LinkStatus): boolean {
  return LINK_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: LinkStatus,
    public readonly to: LinkStatus,
  ) {
    super(
      `transicao de status invalida: ${from} -> ${to}. ` +
        `Permitidas a partir de ${from}: ${LINK_TRANSITIONS[from].join(', ')}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: LinkStatus, to: LinkStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
