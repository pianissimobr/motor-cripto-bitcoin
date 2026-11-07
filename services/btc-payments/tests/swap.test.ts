import { describe, expect, it } from 'vitest';
import {
  assertSwapTransition,
  canTransitionSwap,
  isFinalSwapStatus,
  isSwapSuccess,
  mapSwapKitStatus,
  SwapTransitionError,
} from '../src/domain/swap.js';

describe('estados do swap', () => {
  it('so o `liquidado` e sucesso', () => {
    expect(isSwapSuccess('liquidado')).toBe(true);
    expect(isSwapSuccess('trocado')).toBe(false);
    expect(isSwapSuccess('depositado')).toBe(false);
  });

  it('`completed` do provedor vira `trocado`, nunca `liquidado`', () => {
    // O provedor dizer que entregou nao e prova: a prova e a leitura on-chain.
    expect(mapSwapKitStatus('completed')).toBe('trocado');
    expect(mapSwapKitStatus('swapped')).toBe('trocado');
  });

  it('estado desconhecido do provedor nunca vira sucesso', () => {
    expect(mapSwapKitStatus(null)).toBe('pendente');
    expect(mapSwapKitStatus('qualquer_coisa_nova' as never)).toBe('pendente');
    expect(mapSwapKitStatus('deposited')).toBe('depositado');
    expect(mapSwapKitStatus('awaiting_deposit')).toBe('aguardando_deposito');
    expect(mapSwapKitStatus('failed')).toBe('falhou');
    expect(mapSwapKitStatus('refunded')).toBe('reembolsado');
    expect(mapSwapKitStatus('expired')).toBe('expirado');
    expect(mapSwapKitStatus('manual_review')).toBe('manual');
  });

  it('caminho felizallowed', () => {
    expect(canTransitionSwap('criando', 'aguardando_deposito')).toBe(true);
    expect(canTransitionSwap('aguardando_deposito', 'depositado')).toBe(true);
    expect(canTransitionSwap('depositado', 'trocado')).toBe(true);
    expect(canTransitionSwap('trocado', 'liquidado')).toBe(true);
  });

  it('nao pula do `aguardando_deposito` direto para `liquidado`', () => {
    expect(canTransitionSwap('aguardando_deposito', 'liquidado')).toBe(false);
    expect(() => assertSwapTransition('aguardando_deposito', 'liquidado')).toThrow(
      SwapTransitionError,
    );
  });

  it('estado final nao volta', () => {
    expect(isFinalSwapStatus('liquidado')).toBe(true);
    expect(isFinalSwapStatus('expirado')).toBe(true);
    expect(isFinalSwapStatus('falhou')).toBe(true);
    expect(isFinalSwapStatus('trocado')).toBe(false);
    expect(canTransitionSwap('liquidado', 'falhou')).toBe(false);
  });

  it('duas transicoes iguais sao aceitas', () => {
    expect(canTransitionSwap('trocado', 'trocado')).toBe(true);
  });
});
