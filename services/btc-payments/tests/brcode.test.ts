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
    const parts = ['000201', tag('26', accountInfo), tag('53', '978')].join('');
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

  it('gera exatamente o exemplo do manual do BR Code do Banco Central', () => {
    const bcb =
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
    expect(
      buildBrCode({ key: '123e4567-e12b-12d1-a456-426655440000', merchantName: 'Fulano de Tal', city: 'BRASILIA' }),
    ).toBe(bcb);
  });

  it('o codigo gerado tem a tag 00 uma vez so e passa no proprio parser', () => {
    const code = buildBrCode({ key: 'adm@pianolabribeirao.com.br', amount: '6.50', txid: 'PR123' });
    expect(code.startsWith('000201')).toBe(true);
    expect(code.startsWith('000201000201')).toBe(false);
    expect(parseBrCode(code).amount).toBe('6.50');
  });

  it('tira acento do nome e da cidade e recusa campo acima de 99 caracteres', () => {
    const code = buildBrCode({ key: 'a@b.co', merchantName: 'Pianolab Ribeirão', city: 'Ribeirão Preto' });
    expect(code).toContain('5917Pianolab Ribeirao');
    expect(code).toContain('6014Ribeirao Preto');
    expect(() => buildBrCode({ key: `${'a'.repeat(80)}@b.co` })).toThrow(/99 caracteres/);
  });

  it('recusa QR com tag repetida, mesmo com CRC valido', () => {
    const tag = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;
    const account = (key: string) => tag('26', tag('00', 'br.gov.bcb.pix') + tag('01', key));
    const body = '000201' + account('vitima@exemplo.com') + account('atacante@exemplo.com') +
      tag('52', '0000') + tag('53', '986') + tag('54', '10.00') + tag('58', 'BR') + tag('59', 'LOJA') + tag('60', 'SAO PAULO') + '6304';
    expect(() => parseBrCode(body + brCodeCrc16(body))).toThrow(/tag repetida/);
  });

  it('aceita QR dinamico (URL da cobranca no lugar da chave)', () => {
    const tag = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;
    const account = tag('26', tag('00', 'br.gov.bcb.pix') + tag('25', 'pix.exemplo.com.br/qr/v2/cobv/9d36b84f'));
    const body = '000201' + tag('01', '12') + account + tag('52', '0000') + tag('53', '986') + tag('54', '42.50') +
      tag('58', 'BR') + tag('59', 'LOJA EXEMPLO') + tag('60', 'SAO PAULO') + tag('62', tag('05', '***')) + '6304';
    const parsed = parseBrCode(body + brCodeCrc16(body));
    expect(parsed.dynamic).toBe(true);
    expect(parsed.key).toBeNull();
    expect(parsed.locationUrl).toBe('pix.exemplo.com.br/qr/v2/cobv/9d36b84f');
    expect(parsed.amount).toBe('42.50');
  });

  it('recusa bloco 26 sem chave e sem URL', () => {
    const tag = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;
    const body = '000201' + tag('26', tag('00', 'br.gov.bcb.pix')) + tag('53', '986') + '6304';
    expect(() => parseBrCode(body + brCodeCrc16(body))).toThrow(/sem chave Pix/);
  });
});
