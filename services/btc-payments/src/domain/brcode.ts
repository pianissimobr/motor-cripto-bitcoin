/**
 * BR Code do Pix (EMV): parser e conference do CRC16.
 *
 * O QR Code do Pix é **dado hostil**: o app valida antes de mostrar a tela de
 * confirmação, mas o motor também valida (D28) — com o app virando cliente
 * de API, a confiança nele muda de natureza. Um codigo adulterado aqui vira
 * 400 `br_code_invalido` antes de chegar na Lunium.
 *
 * Formato: `brcode|convencao|campos...|CRC16`, onde o campo `54` e o CRC e
 * `6304` o tamanho do BR Code.
 */

export type BrCode = {
  /** Chave Pix (campo 26). */
  key: string | null;
  /** Valor em reais (campo 54), quando o QR tem valor. */
  amount: string | null;
  /** Nome do recebedor (campo 53). */
  merchantName: string | null;
  /** Cidade (campo 60). */
  city: string | null;
  /** Descricao (campo 59). */
  description: string | null;
  /** Payload EMV sem o CRC (para recalcular). */
  payload: string;
};

export class BrCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrCodeError';
  }
}

/**
 * CRC16-CCITT do BR Code: polinomio 0x1021, semente 0xFFFF, sobre o
 * payload EMV sem o campo `54`.
 */
export function brCodeCrc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc &= 0xffff;
      crc <<= 1;
      if (crc & 0x10000) crc ^= 0x1021;
    }
  }
  crc &= 0xffff;
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** `true` quando o BR Code tem o formato e o CRC16 conferem. */
export function isValidBrCode(code: string): boolean {
  try {
    parseBrCode(code);
    return true;
  } catch {
    return false;
  }
}

/**
 * Le o BR Code e confere o CRC16.
 *
 * Lanca `BrCodeError` quando o codigo nao e um BR Code valido.
 */
export function parseBrCode(code: string): BrCode {
  const raw = (code ?? '').trim();
  if (!raw.startsWith('000201')) {
    throw new BrCodeError('BR Code invalido: prefixo EMV ausente');
  }
  if (!raw.includes('5802BR') && !raw.includes('br.gov.bcb.pix')) {
    throw new BrCodeError('BR Code invalido: nao e um Pix do Banco Central');
  }
  const parts = raw.split('|');
  if (parts.length < 3) {
    throw new BrCodeError('BR Code invalido: estrutura incompleta');
  }

  // O ultimo campo e o CRC; o payload e tudo antes dele.
  const crcField = parts[parts.length - 1] ?? '';
  const payload = parts.slice(0, -1).join('|');
  const expected = brCodeCrc16(payload);
  if (crcField.toUpperCase() !== expected) {
    throw new BrCodeError(
      `BR Code invalido: CRC16 esperado ${expected}, recebido ${crcField.toUpperCase()}`,
    );
  }

  const fields = new Map<string, string>();
  for (const part of parts.slice(2, -1)) {
    const id = part.slice(0, 2);
    const len = Number(part.slice(2, 4));
    if (!Number.isInteger(len) || len < 0) continue;
    fields.set(id, part.slice(4, 4 + len));
  }

  const key = fields.get('26') ?? null;
  const amount = fields.get('54') ?? null;
  if (!key) {
    throw new BrCodeError('BR Code invalido: chave Pix ausente');
  }
  if (amount !== null && !/^\d+(\.\d{2})?$/.test(amount)) {
    throw new BrCodeError('BR Code invalido: valor malformado');
  }

  return {
    key,
    amount,
    merchantName: fields.get('53') ?? null,
    city: fields.get('60') ?? null,
    description: fields.get('59') ?? null,
    payload,
  };
}

/**
 * Mascara a chave Pix para exibição: e-mail e telefone ficam com o miolo
 * trocado por um bullet (o mesmo que a Lunium devolve).
 */
export function maskPixKey(key: string): string {
  if (key.includes('@')) {
    const [user, domain] = key.split('@');
    if (!domain) return key;
    const head = (user ?? '').slice(0, 1);
    return `${head}•@${domain}`;
  }
  if (key.length <= 4) return key;
  return `${key.slice(0, 2)}${'•'.repeat(Math.max(1, key.length - 4))}${key.slice(-2)}`;
}
