import { describe, expect, it } from 'vitest';
import {
  assertPixChargeTransition,
  canTransitionPixCharge,
  isFinalPixStatus,
  mapLuniumStatus,
} from '../src/domain/pix.js';

describe('estados da cobranca PIX', () => {
  it('traduz o estado do provedor para o estado do motor', () => {
    expect(mapLuniumStatus('pending', 'pending')).toBe('pendente');
    expect(mapLuniumStatus('paid', 'pending')).toBe('pago');
    expect(mapLuniumStatus('paid', 'sent')).toBe('liquidado');
    expect(mapLuniumStatus('expired', 'pending')).toBe('expirado');
    expect(mapLuniumStatus('refunded', 'sent')).toBe('reembolsado');
    expect(mapLuniumStatus('failed', 'failed')).toBe('falhou');
    expect(mapLuniumStatus('paid', 'incerto')).toBe('incerto');
  });

  it('trata `under_review` como manual, nao como pendencia', () => {
    // A Lunium em conferencia (divergencia de documento do pagador) nao e uma
    // pendencia normal: o Pix pode estar pago e a entrega nao vem sozinha.
    // Como `pendente`, a cobranca ficaria "normal" por horas, sem alerta.
    expect(mapLuniumStatus('under_review', 'pending')).toBe('manual');
    // E da para sair de manual quando a conferencia libera.
    expect(canTransitionPixCharge('manual', 'pago')).toBe(true);
    expect(canTransitionPixCharge('manual', 'liquidado')).toBe(true);
    expect(canTransitionPixCharge('pendente', 'manual')).toBe(true);
  });

  it('nao sai de um estado final', () => {
    expect(isFinalPixStatus('expirado')).toBe(true);
    expect(isFinalPixStatus('reembolsado')).toBe(true);
    expect(isFinalPixStatus('pendente')).toBe(false);
    expect(canTransitionPixCharge('expirado', 'pago')).toBe(false);
    expect(canTransitionPixCharge('reembolsado', 'pago')).toBe(false);
  });

  it('recusa transicao invalida', () => {
    expect(() => assertPixChargeTransition('pendente', 'liquidado')).not.toThrow();
    expect(() => assertPixChargeTransition('expirado', 'liquidado')).toThrow(
      /transicao de cobranca PIX invalida/,
    );
  });
});
