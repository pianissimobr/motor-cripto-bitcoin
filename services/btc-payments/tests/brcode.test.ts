import { describe, expect, it } from 'vitest';
import {
  BrCodeError,
  brCodeCrc16,
  buildBrCode,
  isValidBrCode,
  maskPixKey,
  parseBrCode,
} from '../src/domain/brcode.js';

/**
 * Constroi um BR Code no formato EMV do BACEN — o mesmo do app
 * (`blue_modules/pix/brcode.ts`): `000201` + tags + `6304` + CRC16.
 */
function buildFixture(fields: {
  key: string;
  amount?: string;
  merchantName?: string;
  city?: string;
}): string {
  const tag = (id: string, value: string) =>
    `${id}${String(value.length).padStart(2, '0')}${value}`;
  const accountInfo = tag('00', 'br.gov.bcb.pix') + tag('01', fields.key);
  const parts = [
    '000201',
    tag('00', '01'),
    tag('26', accountInfo),
    tag('52', '0000'),
    tag('53', '986'),
    fields.amount ? tag('54', fields.amount) : '',
    tag('58', 'BR'),
    tag('59', fields.merchantName ?? 'PIANOLAB RIBEIRAO'),
    tag('60', fields.city ?? 'RIBEIRAO PRETO'),
    tag('62', tag('05', '***')),
  ].filter(part => part.length > 0);
  const withoutCrc = parts.join('');
  return `${withoutCrc}6304${brCodeCrc16(`${withoutCrc}6304`)}`;
}

describe('BR Code do Pix', () => {
  it('aceita um codigo valido e le a chave, o valor e o recebedor', () => {
    const code = buildFixture({
      key: 'adm@pianolabribeirao.com.br',
      amount: '6.50',
      merchantName: 'PIANOLAB RIBEIRAO',
    });
    const parsed = parseBrCode(code);
    expect(parsed.key).toBe('adm@pianolabribeirao.com.br');
    expect(parsed.keyType).toBe('email');
    expect(parsed.amount).toBe('6.50');
    expect(parsed.merchantName).toBe('PIANOLAB RIBEIRAO');
    expect(parsed.city).toBe('RIBEIRAO PRETO');
  });

  it('recusa um codigo adulterado (CRC16 nao confere)', () => {
    const code = buildFixture({ key: '12345678909', amount: '6.50' });
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
    const code = buildFixture({ key: '12345678909' });
    const parsed = parseBrCode(code);
    expect(parsed.key).toBe('12345678909');
    expect(parsed.keyType).toBe('cpf');
    expect(parsed.amount).toBeNull();
  });

  it('recusa moeda que nao e BRL', () => {
    const tag = (id: string, value: string) =>
      `${id}${String(value.length).padStart(2, '0')}${value}`;
    const accountInfo = tag('00', 'br.gov.bcb.pix') + tag('01', '12345678909');
    const parts = ['000201', tag('00', '01'), tag('26', accountInfo), tag('53', '978')].join('');
    const code = `${parts}6304${brCodeCrc16(`${parts}6304`)}`;
    expect(() => parseBrCode(code)).toThrow(/moeda nao suportada/);
  });

  it('monta um BR Code que o proprio motor le de volta', () => {
    const code = buildBrCode({
      key: '12345678909',
      merchantName: 'PIANO LAB',
      city: 'RIBEIRAO PRETO',
      amount: '100.00',
      txid: 'PR123',
    });

    expect(code.startsWith('000201')).toBe(true);
    expect(isValidBrCode(code)).toBe(true);

    const parsed = parseBrCode(code);
    expect(parsed.key).toBe('12345678909');
    expect(parsed.keyType).toBe('cpf');
    expect(parsed.amount).toBe('100.00');
    expect(parsed.merchantName).toBe('PIANO LAB');
    expect(parsed.city).toBe('RIBEIRAO PRETO');
    expect(parsed.txid).toBe('PR123');
  });

  it('limpa o txid: o padrao EMV so aceita alfanumericos', () => {
    const code = buildBrCode({ key: '12345678909', txid: 'PR-123/456' });
    expect(parseBrCode(code).txid).toBe('PR123456');
  });

  it('recusa chave vazia', () => {
    expect(() => buildBrCode({ key: '  ' })).toThrow(BrCodeError);
  });

  it('mascara a chave Pix para exibicao', () => {
    expect(maskPixKey('adm@pianolabribeirao.com.br')).toBe('a•@pianolabribeirao.com.br');
    expect(maskPixKey('12345678909')).toContain('•');
  });
});
