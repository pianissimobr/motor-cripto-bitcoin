import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isFinalStatus,
  isPaidStatus,
} from '../src/domain/status.js';

describe('status', () => {
  it('permite transicoes validas', () => {
    expect(canTransition('pendente', 'pago')).toBe(true);
    expect(canTransition('pendente', 'expirado')).toBe(true);
    expect(canTransition('expirado', 'pago_tardio')).toBe(true);
    expect(canTransition('pago', 'reorg')).toBe(true);
    expect(canTransition('reorg', 'pago')).toBe(true);
  });

  it('rejeita transicoes invalidas', () => {
    expect(() => assertTransition('cancelado', 'pago')).toThrow(
      IllegalTransitionError,
    );
    expect(canTransition('falha_criacao', 'pendente')).toBe(false);
  });

  it('identifica estados finais e pagos', () => {
    expect(isFinalStatus('pago')).toBe(true);
    expect(isFinalStatus('pendente')).toBe(false);
    expect(isPaidStatus('pago_tardio')).toBe(true);
    expect(isPaidStatus('expirado')).toBe(false);
  });
});
