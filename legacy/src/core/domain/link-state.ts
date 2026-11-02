/**
 * Transicoes de status do link.
 *
 * O link nasce `aguardando` (pagina ativa). Quando a pagina vence ele vira
 * `expirado`, mas a janela de liquidacao on-chain continua. No fim dessa
 * janela ele termina em `pago` (valor cheio) ou `nao_realizado` (sem
 * pagamento / valor parcial / pagamento apos o prazo / revogado / reorg).
 *
 * `nao_realizado` e terminal. Dinheiro que chega depois ainda e detectado,
 * registrado em `valorRecebidoBaseUnits` e varrido para a carteira do
 * cliente, mas nao muda mais o status.
 */

import { ConflictError } from './errors.js';
import type { LinkStatus } from './types.js';

export const LINK_TRANSITIONS: Record<LinkStatus, readonly LinkStatus[]> = {
  aguardando: ['pago', 'parcial', 'pago_sem_gas', 'expirado', 'nao_realizado'],
  // `aguardando` so volta por reorg: o pagamento deixou de existir.
  pago: ['aguardando', 'parcial', 'pago_sem_gas', 'movido', 'nao_realizado'],
  parcial: ['aguardando', 'pago', 'pago_sem_gas', 'expirado', 'nao_realizado'],
  pago_sem_gas: ['aguardando', 'pago', 'parcial', 'movido', 'nao_realizado'],
  // `movido` so volta atras por reorg.
  movido: ['aguardando', 'pago', 'parcial'],
  expirado: ['aguardando', 'pago', 'parcial', 'pago_sem_gas', 'nao_realizado'],
  nao_realizado: [],
};

export function canTransition(from: LinkStatus, to: LinkStatus): boolean {
  return LINK_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends ConflictError {
  constructor(
    public readonly from: LinkStatus,
    public readonly to: LinkStatus,
  ) {
    super(
      `transicao de status invalida: ${from} -> ${to}. ` +
        `Permitidas a partir de ${from}: ${LINK_TRANSITIONS[from].join(', ') || '(nenhuma)'}`,
      'transicao_invalida',
    );
  }
}

export function assertTransition(from: LinkStatus, to: LinkStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
