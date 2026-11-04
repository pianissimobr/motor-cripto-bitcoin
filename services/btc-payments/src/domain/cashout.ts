import type { CashOutProviderState, CashOutStatus } from './types.js';

/**
 * Máquina de estados do cash-out (cripto -> Pix).
 *
 * O motor é quem traduz o estado do provedor (a Lunium) para o estado
 * canônico do produto (D29). O estado cru vai junto em `provider_state`, para
 * quando o app precisar mostrar a palavra do provedor.
 *
 * O caminho feliz: o app pede a venda, a Lunium devolve o endereço de
 * depósito, o app envia o USDC (assinatura local), a Lunium vende e paga o
 * Pix.
 */

const TRANSITIONS: Record<CashOutStatus, readonly CashOutStatus[]> = {
  criando: ['pendente', 'aguardando_deposito', 'depositado', 'pago', 'liquidado', 'falhou', 'incerto', 'manual', 'expirado'],
  pendente: ['aguardando_deposito', 'depositado', 'pago', 'liquidado', 'falhou', 'incerto', 'manual', 'expirado'],
  aguardando_deposito: ['depositado', 'pago', 'liquidado', 'falhou', 'incerto', 'manual', 'expirado'],
  depositado: ['pago', 'liquidado', 'falhou', 'incerto', 'manual'],
  pago: ['liquidado', 'falhou', 'incerto', 'manual'],
  liquidado: ['manual'],
  expirado: [],
  reembolsado: [],
  falhou: ['pendente', 'aguardando_deposito', 'depositado', 'pago', 'liquidado', 'incerto', 'manual'],
  incerto: ['pendente', 'aguardando_deposito', 'depositado', 'pago', 'liquidado', 'falhou', 'manual'],
  manual: ['pendente', 'aguardando_deposito', 'depositado', 'pago', 'liquidado', 'falhou'],
};

export class CashOutTransitionError extends Error {
  constructor(
    public readonly from: CashOutStatus,
    public readonly to: CashOutStatus,
  ) {
    super(`transicao de cash-out invalida: ${from} -> ${to}`);
    this.name = 'CashOutTransitionError';
  }
}

export function canTransitionCashOut(from: CashOutStatus, to: CashOutStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertCashOutTransition(from: CashOutStatus, to: CashOutStatus): void {
  if (!canTransitionCashOut(from, to)) {
    throw new CashOutTransitionError(from, to);
  }
}

/**
 * Estado do provedor -> estado canonico.
 *
 * `COMPLETED` e o unico sucesso (o Pix caiu). `PAYING_OUT`, `SOLD` e
 * `DEPOSIT_CONFIRMED` **nao** sao sucesso: a venda esta em curso.
 *
 * `AWAITING_REFUND_ADDRESS`, `REFUNDING` e `REFUNDING_CRYPTO` viram `manual`:
 * a venda falhou e a ordem precisa de uma carteira de devolucao — e essa
 * decisao e nossa, nao da Lunium.
 */
export function mapLuniumCashOutState(state: CashOutProviderState | null): CashOutStatus {
  switch (state) {
    case 'COMPLETED':
      return 'liquidado';
    case 'FAILED':
      return 'falhou';
    case 'EXPIRED':
      return 'expirado';
    case 'REFUNDED':
      return 'reembolsado';
    case 'MANUAL_REVIEW':
    case 'AWAITING_REFUND_ADDRESS':
    case 'REFUNDING':
    case 'REFUNDING_CRYPTO':
      return 'manual';
    case 'DEPOSIT_DETECTED':
    case 'DEPOSIT_CONFIRMED':
      return 'depositado';
    case 'SELLING':
    case 'SOLD':
    case 'FORWARDING':
    case 'PAYING_OUT':
      return 'pago';
    case 'AWAITING_DEPOSIT':
      return 'aguardando_deposito';
    case 'QUOTE_CREATED':
    case 'DELAYED':
    case 'PROCESSING':
    default:
      return 'pendente';
  }
}

/** Estado final: não muda mais. */
export function isFinalCashOutStatus(status: CashOutStatus): boolean {
  return status === 'expirado' || status === 'reembolsado' || status === 'liquidado' || status === 'falhou';
}

/** Sucesso do cash-out: o Pix foi pago. */
export function isCashOutSuccess(status: CashOutStatus): boolean {
  return status === 'liquidado';
}
