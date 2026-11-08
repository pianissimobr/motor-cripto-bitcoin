/**
 * CPF e CNPJ do pagador: normaliza e confere os digitos verificadores.
 *
 * Sem a conferencia, um CPF digitado errado so era recusado pela Lunium (ou
 * nem isso), e cada variacao contava como um CPF distinto no limite diario de
 * consultas. O CNPJ aceita o formato alfanumerico da Receita (12 caracteres
 * `[0-9A-Z]` + 2 digitos verificadores, em vigor desde julho de 2026): o
 * calculo e o mesmo modulo 11, com o valor de cada caractere = codigo ASCII
 * menos 48, o que da o resultado de sempre para o CNPJ so de digitos.
 */

export type TaxIdKind = 'cpf' | 'cnpj';

const checkDigit = (values: number[], weights: number[]): number => {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]! * weights[i]!;
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
};

export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const values = [...digits].map(Number);
  const first = checkDigit(values.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = checkDigit(values.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === values[9] && second === values[10];
}

export function isValidCnpj(value: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const values = [...value].map((char) => char.charCodeAt(0) - 48);
  const first = checkDigit(values.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = checkDigit(values.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === values[12] && second === values[13];
}

/**
 * Tira a pontuacao (`.`, `-`, `/`, espacos) e devolve o CPF/CNPJ limpo, ou
 * `null` quando o tamanho ou os digitos verificadores nao conferem.
 */
export function normalizeTaxId(input: string): { kind: TaxIdKind; value: string } | null {
  const clean = input.toUpperCase().replace(/[\s.\-/]/g, '');
  if (clean.length === 11 && isValidCpf(clean)) return { kind: 'cpf', value: clean };
  if (clean.length === 14 && isValidCnpj(clean)) return { kind: 'cnpj', value: clean };
  return null;
}
