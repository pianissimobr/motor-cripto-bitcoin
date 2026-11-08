import { describe, expect, it } from 'vitest';
import { centsCell, csvCell, toCsv } from '../src/services/export-service.js';

describe('exportacao CSV', () => {
  it('neutraliza formula (CSV injection) e escapa separador', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+5511')).toBe("'+5511");
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('pedido-1')).toBe('pedido-1');
  });

  it('valor com virgula decimal e BOM no inicio', () => {
    expect(centsCell(123456n)).toBe('1234,56');
    expect(centsCell(7n)).toBe('0,07');
    const csv = toCsv([
      {
        createdAt: new Date('2026-11-08T15:00:00Z'),
        tipo: 'fatura',
        id: 'x',
        pedido: '1',
        status: 'pago',
        valorCents: 9990n,
        moeda: 'BRL',
        meio: 'pix',
        pagoEm: null,
        carteira: null,
        transacao: null,
      },
    ]);
    expect(csv.startsWith('﻿data;')).toBe(true);
    expect(csv).toContain('2026-11-08 12:00:00;fatura;x;1;pago;99,90;BRL;pix;;;');
  });
});
