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

import { formatUsdc, usdcMinorFor } from '../src/services/invoice-service.js';

describe('valor em USDC', () => {
  it('real convertido pela cotacao, arredondado para cima ate o centavo', () => {
    // dolar a R$ 5: R$ 100 = 20 USDC
    expect(usdcMinorFor(10_000n, 'BRL', { brl: 500n, usd: 100n })).toBe(20_000_000n);
    // R$ 1,00 a 5,33 por dolar = 0,1876... -> 0,19
    expect(usdcMinorFor(100n, 'BRL', { brl: 533n, usd: 100n })).toBe(190_000n);
    expect(usdcMinorFor(1_234n, 'USD')).toBe(12_340_000n);
    expect(() => usdcMinorFor(100n, 'BRL')).toThrow(/cotacao/);
  });

  it('formata com 6 casas', () => {
    expect(formatUsdc(20_000_123n)).toBe('20.000123');
  });
});
