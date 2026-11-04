import { describe, expect, it } from 'vitest';
import {
  BrCodeError,
  brCodeCrc16,
  isValidBrCode,
  maskPixKey,
  parseBrCode,
} from '../src/domain/brcode.js';

/**
 * BR Code real, gerado com a mesma_library do app (o app valida tambem — mas
 * o motor precisa validar sozinho: D28).
 */
function buildBrCode(fields: {
  key: string;
  amount?: string;
  name?: string;
  city?: string;
}): string {
  const tag = (id: string, value: string) =>
    `${id}${value.length.toString().padStart(2, '0')}${value}`;
  const payload = [
    '000201',
    tag('00', 'br.gov.bcb.pix'),
    tag('26', fields.key),
    tag('52', '0000'),
    tag('53', fields.name ?? 'TESTE'),
    tag('58', 'BR'),
    tag('60', fields.city ?? 'SAO PAULO'),
    ...(fields.amount ? [tag('54', fields.amount)] : []),
    tag('62', tag('05', fields.amount ?? '***')),
  ].join('|');
  return `${payload}|${brCodeCrc16(payload)}`;
}

describe('BR Code do Pix', () => {
  it('aceita um codigo valido e le a chave, o valor e o recebedor', () => {
    const code = buildBrCode({
      key: 'adm@pianolabribeirao.com.br',
      amount: '6.50',
      name: 'PIANOLAB RIBEIRAO',
    });
    const parsed = parseBrCode(code);
    expect(parsed.key).toBe('adm@pianolabribeirao.com.br');
    expect(parsed.amount).toBe('6.50');
    expect(parsed.merchantName).toBe('PIANOLAB RIBEIRAO');
    expect(parsed.city).toBe('SAO PAULO');
  });

  it('recusa um codigo adulterado (CRC16 nao confere)', () => {
    const code = buildBrCode({ key: '12345678909', amount: '6.50' });
    const adulterado = code.replace('6.50', '65.00');
    expect(isValidBrCode(adulterado)).toBe(false);
    expect(() => parseBrCode(adulterado)).toThrow(BrCodeError);
  });

  it('recusa o que nao e BR Code', () => {
    expect(isValidBrCode('https://exemplo.com/pagamento')).toBe(false);
    expect(isValidBrCode('')).toBe(false);
    expect(isValidBrCode('000201')).toBe(false);
  });

  it('aceita um codigo sem valor (o usuario digita depois)', () => {
    const code = buildBrCode({ key: '12345678909' });
    const parsed = parseBrCode(code);
    expect(parsed.key).toBe('12345678909');
    expect(parsed.amount).toBeNull();
  });

  it('mascara a chave Pix para exibicao', () => {
    expect(maskPixKey('adm@pianolabribeirao.com.br')).toBe('a•@pianolabribeirao.com.br');
    expect(maskPixKey('12345678909')).toContain('•');
  });
});
