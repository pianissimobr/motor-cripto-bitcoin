import type { SwapProviderState, SwapStatus } from './types.js';

/**
 * Maquina de estados do swap (Bitcoin -> dolar digital).
 *
 * O motor e quem traduz o estado do provedor (a SwapKit) para o estado
 * canonico do produto. O estado cru vai junto em `provider_state`, para quando
 * o app precisar mostrar a palavra do provedor.
 *
 * O caminho feliz: o motor cota o par, pede o deposito a SwapKit e devolve o
 * endereco de BTC; o pagador envia o BTC; a SwapKit troca e entrega o USDC na
 * Polygon; o motor **confere a entrega on-chain** e so entao marca
 * `liquidado`.
 *
 * A distincao entre `trocado` e `liquidado` e o mesmo principle do Pix: o
 * provedor dizer que entregou nao e prova. A prova e o `Transfer` do ERC-20
 * lido na chain.
 */

const TRANSITIONS: Record<SwapStatus, readonly SwapStatus[]> = {
  criando: ['pendente', 'aguardando_deposito', 'falhou', 'incerto', 'manual', 'expirado'],
  pendente: ['aguardando_deposito', 'depositado', 'trocado', 'falhou', 'incerto', 'manual', 'expirado'],
  aguardando_deposito: ['depositado', 'trocado', 'falhou', 'incerto', 'manual', 'expirado', 'reembolsado'],
  depositado: ['trocado', 'falhou', 'incerto', 'manual', 'reembolsado'],
  trocado: ['liquidado', 'falhou', 'incerto', 'manual'],
  liquidado: ['manual'],
  expirado: [],
  reembolsado: [],
  falhou: ['pendente', 'aguardando_deposito', 'incerto', 'manual'],
  incerto: ['pendente', 'aguardando_deposito', 'depositado', 'trocado', 'liquidado', 'falhou', 'manual'],
  manual: ['pendente', 'aguardando_deposito', 'depositado', 'trocado', 'liquidado', 'falhou'],
};

export class SwapTransitionError extends Error {
  constructor(
    public readonly from: SwapStatus,
    public readonly to: SwapStatus,
  ) {
    super(`transicao de swap invalida: ${from} -> ${to}`);
    this.name = 'SwapTransitionError';
  }
}

export function canTransitionSwap(from: SwapStatus, to: SwapStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertSwapTransition(from: SwapStatus, to: SwapStatus): void {
  if (!canTransitionSwap(from, to)) {
    throw new SwapTransitionError(from, to);
  }
}

/**
 * Estado do provedor -> estado canonico.
 *
 * `completed` vira `trocado`, **nao** `liquidado`: a SwapKit dizer que
 * entregou nao prova que o USDC chegou na carteira do cliente. O
 * `liquidado` so vem da leitura on-chain.
 *
 * Um estado desconhecido vira `pendente`: nunca um sucesso. O provider
 * pode inventar nomes novos; o motor nao pode adivinhar que deu certo.
 */
export function mapSwapKitStatus(status: SwapProviderState | null): SwapStatus {
  switch (status) {
    case 'completed':
    case 'swapped':
    case 'swap_completed':
      return 'trocado';
    case 'deposited':
    case 'deposit_detected':
    case 'deposit_confirmed':
      return 'depositado';
    case 'awaiting_deposit':
    case 'deposit_pending':
    case 'funding':
      return 'aguardando_deposito';
    case 'failed':
    case 'error':
      return 'falhou';
    case 'refunded':
    case 'refund':
      return 'reembolsado';
    case 'expired':
      return 'expirado';
    case 'manual_review':
    case 'under_review':
      return 'manual';
    case 'pending':
    case 'waiting':
    case 'created':
    case 'new':
    default:
      return 'pendente';
  }
}

/** Estado final: nao muda mais. */
export function isFinalSwapStatus(status: SwapStatus): boolean {
  return (
    status === 'expirado' ||
    status === 'reembolsado' ||
    status === 'liquidado' ||
    status === 'falhou'
  );
}

/** Sucesso do swap: o USDC foi confirmado na carteira de destino. */
export function isSwapSuccess(status: SwapStatus): boolean {
  return status === 'liquidado';
}
