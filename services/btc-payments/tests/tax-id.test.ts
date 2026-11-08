import { describe, expect, it } from 'vitest';
import { isValidCnpj, isValidCpf, normalizeTaxId } from '../src/domain/tax-id.js';
import { normalizePayerTax } from '../src/services/pix-charge-service.js';

describe('CPF e CNPJ do pagador', () => {
  it('aceita CPF valido com ou sem pontuacao', () => {
    expect(normalizeTaxId('000.000.001-91')).toEqual({ kind: 'cpf', value: '00000000191' });
    expect(normalizeTaxId('529.982.247-25')).toEqual({ kind: 'cpf', value: '52998224725' });
  });

  it('recusa CPF com digito errado ou repetido', () => {
    expect(isValidCpf('52998224724')).toBe(false);
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('00000000000')).toBe(false);
    expect(normalizeTaxId('123.456.789-00')).toBeNull();
  });

  it('aceita CNPJ numerico e alfanumerico', () => {
    expect(normalizeTaxId('11.222.333/0001-81')).toEqual({ kind: 'cnpj', value: '11222333000181' });
    expect(normalizeTaxId('12.abc.345/01de-35')).toEqual({ kind: 'cnpj', value: '12ABC34501DE35' });
  });

  it('recusa CNPJ com digito errado, repetido ou letra no verificador', () => {
    expect(isValidCnpj('11222333000182')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
    expect(isValidCnpj('12ABC34501DE3A')).toBe(false);
  });

  it('recusa tamanho errado e lixo', () => {
    for (const bad of ['', '123', '000000001911', 'abc.def.ghi-jk']) {
      expect(normalizeTaxId(bad)).toBeNull();
    }
  });

  it('a cobranca Pix recusa CPF invalido com 400', () => {
    expect(() => normalizePayerTax('123.456.789-00')).toThrow(/CPF ou CNPJ valido/);
    expect(normalizePayerTax('000.000.001-91')).toBe('00000000191');
  });
});
