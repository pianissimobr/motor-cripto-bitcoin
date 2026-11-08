import { describe, expect, it } from 'vitest';
import { deriveInvoiceStatus, priceToCents } from '../src/services/invoice-service.js';

const now = new Date('2026-11-08T12:00:00Z');
const later = new Date('2026-11-08T13:00:00Z');
const earlier = new Date('2026-11-08T11:00:00Z');
const base = { current: 'aguardando' as const, pix: null, bitcoin: null, expiresAt: later, now };

describe('estado da fatura', () => {
  it('Pix pago ou swap liquidado: pago', () => {
    expect(deriveInvoiceStatus({ ...base, pix: 'pago' })).toEqual({ status: 'pago', paidRail: 'pix' });
    expect(deriveInvoiceStatus({ ...base, bitcoin: 'liquidado' })).toEqual({ status: 'pago', paidRail: 'bitcoin' });
  });

  it('Bitcoin chegou e esta convertendo: confirmando, mesmo vencida', () => {
    expect(deriveInvoiceStatus({ ...base, bitcoin: 'depositado', expiresAt: earlier }).status).toBe('confirmando');
  });

  it('vencida sem nada em andamento: expirado; pagamento atrasado ainda vira pago', () => {
    expect(deriveInvoiceStatus({ ...base, expiresAt: earlier }).status).toBe('expirado');
    expect(deriveInvoiceStatus({ ...base, current: 'expirado', pix: 'pago', expiresAt: earlier }).status).toBe('pago');
  });

  it('cancelado e pago nao voltam', () => {
    expect(deriveInvoiceStatus({ ...base, current: 'pago' }).status).toBe('pago');
    expect(deriveInvoiceStatus({ ...base, current: 'cancelado', pix: 'pago' }).status).toBe('cancelado');
  });
});

describe('price_amount', () => {
  it('converte sem float', () => {
    expect(priceToCents('99.90')).toBe(9990n);
    expect(priceToCents('0,29')).toBe(29n);
    expect(priceToCents('100')).toBe(10000n);
    for (const bad of ['0', '-1', '1.005', '1e3', '']) expect(() => priceToCents(bad)).toThrow();
  });
});
