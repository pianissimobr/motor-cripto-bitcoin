import type {
  PixChargeStatus,
  PixProviderSettlementStatus,
  PixProviderStatus,
} from './types.js';

const TRANSITIONS: Record<PixChargeStatus, readonly PixChargeStatus[]> = {
  criando: ['pendente', 'pago', 'liquidado', 'expirado', 'reembolsado', 'falhou', 'incerto', 'manual'],
  pendente: ['pago', 'liquidado', 'expirado', 'reembolsado', 'falhou', 'incerto', 'manual'],
  pago: ['liquidado', 'reembolsado', 'falhou', 'incerto', 'manual'],
  liquidado: ['manual'],
  expirado: [],
  reembolsado: [],
  falhou: ['pendente', 'pago', 'liquidado', 'incerto', 'manual'],
  incerto: ['pendente', 'pago', 'liquidado', 'falhou', 'manual'],
  manual: ['pendente', 'pago', 'liquidado', 'falhou'],
};

export class PixChargeTransitionError extends Error {
  constructor(
    public readonly from: PixChargeStatus,
    public readonly to: PixChargeStatus,
  ) {
    super(`transicao de cobranca PIX invalida: ${from} -> ${to}`);
    this.name = 'PixChargeTransitionError';
  }
}

export function canTransitionPixCharge(
  from: PixChargeStatus,
  to: PixChargeStatus,
): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertPixChargeTransition(
  from: PixChargeStatus,
  to: PixChargeStatus,
): void {
  if (!canTransitionPixCharge(from, to)) {
    throw new PixChargeTransitionError(from, to);
  }
}

export function mapLuniumStatus(
  status: PixProviderStatus | null,
  settlement: PixProviderSettlementStatus | null,
): PixChargeStatus {
  if (status === 'expired') return 'expirado';
  if (status === 'refunded') return 'reembolsado';
  if (status === 'failed') return 'falhou';
  if (settlement === 'incerto') return 'incerto';
  if (settlement === 'failed') return 'falhou';
  if (status === 'paid' && settlement === 'sent') return 'liquidado';
  if (status === 'paid') return 'pago';
  return 'pendente';
}

export function isFinalPixStatus(status: PixChargeStatus): boolean {
  return status === 'expirado' || status === 'reembolsado';
}
