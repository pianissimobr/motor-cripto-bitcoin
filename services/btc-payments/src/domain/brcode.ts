/**
 * BR Code do Pix (EMV): parser e conference do CRC16.
 *
 * O QR Code do Pix é **dado hostil**: o app valida antes de mostrar a tela de
 * confirmação, mas o motor também valida (D28) — com o app virando cliente
 * de API, a confiança nele muda de natureza. Um codigo adulterado aqui vira
 * 400 `br_code_invalido` antes de chegar na LuniumPay.
 *
 * Formato: `000201` + tags EMV (`id` 2 + `len` 2 + valor) + `6304` + CRC16.
 * A chave Pix vem dentro da tag 26, como template (`00` = br.gov.bcb.pix,
 * `01` = a chave).
 *
 * Referência: EMVCo QR Code Payment BR Code (spec do BACEN). A mesma
 * implementação do app (`blue_modules/pix/brcode.ts`), replicada aqui porque o
 * motor precisa conferir sozinho.
 */

export type BrCode = {
  /** Chave Pix (tag 26, subtag 01). */
  key: string;
  /** Tipo deduzido do formato da chave (null quando nao deduzivel). */
  keyType: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random' | null;
  /** Valor em reais (tag 54), quando o QR tem valor. */
  amount: string | null;
  /** Nome do recebedor (tag 59). */
  merchantName: string | null;
  /** Cidade (tag 60). */
  city: string | null;
  /** Codigo do pais (tag 58). */
  country: string | null;
  /** Identificador da transacao (tag 62, subtag 05). */
  txid: string | null;
  /** Payload original. */
  raw: string;
};

export class BrCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrCodeError';
  }
}

/** Prefixo obrigatorio de um BR Code. */
export const BR_CODE_PREFIX = '000201';

/**
 * CRC16-CCITT (FALSE): poly 0x1021, init 0xFFFF, sem reflexao.
 *
 * O CRC e calculado sobre o payload ate o inicio da tag 63, **incluindo** o
 * proprio `6304`.
 */
export function brCodeCrc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Divide o payload EMV em tags (`id` 2 + `len` 2 + valor). */
function parseTags(payload: string): Map<string, string> {
  const tags = new Map<string, string>();
  let offset = 0;
  while (offset < payload.length) {
    if (offset + 4 > payload.length) {
      throw new BrCodeError('BR Code truncado');
    }
    const id = payload.slice(offset, offset + 2);
    const length = Number.parseInt(payload.slice(offset + 2, offset + 4), 10);
    if (Number.isNaN(length)) {
      throw new BrCodeError('BR Code com tamanho de tag invalido');
    }
    const value = payload.slice(offset + 4, offset + 4 + length);
    if (value.length !== length) {
      throw new BrCodeError('BR Code com tag incompleta');
    }
    tags.set(id, value);
    offset += 4 + length;
  }
  return tags;
}

/** Interpreta a sub-estrutura de template (tags dentro de um valor). */
function parseTemplate(value: string): Map<string, string> {
  try {
    return parseTags(value);
  } catch {
    return new Map();
  }
}

/** Deduz o tipo da chave Pix pelo formato. */
export function guessPixKeyType(key: string): NonNullable<BrCode['keyType']> | undefined {
  const clean = key.trim();
  if (/^\+55\d{10,13}$/.test(clean)) return 'phone';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return 'email';
  if (/^\d{11}$/.test(clean)) return 'cpf';
  if (/^\d{14}$/.test(clean)) return 'cnpj';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) {
    return 'random';
  }
  return undefined;
}

/**
 * Valida e extrai os dados de um BR Code.
 *
 * Lanca `BrCodeError` quando o codigo nao e valido.
 */
export function parseBrCode(payload: string): BrCode {
  const raw = (payload ?? '').trim();
  if (raw.length === 0) {
    throw new BrCodeError('QR Code vazio');
  }
  if (!raw.startsWith(BR_CODE_PREFIX)) {
    throw new BrCodeError('nao e um QR Code Pix valido');
  }

  // O CRC16 e calculado sobre o payload inteiro ate o inicio da tag 63,
  // incluindo o proprio "6304".
  const crcIndex = raw.lastIndexOf('6304');
  if (crcIndex === -1) {
    throw new BrCodeError('BR Code sem tag de CRC');
  }
  const payloadWithoutCrc = raw.slice(0, crcIndex + 4);
  const expectedCrc = raw.slice(crcIndex + 4, crcIndex + 8);
  if (!/^[0-9A-F]{4}$/i.test(expectedCrc)) {
    throw new BrCodeError('BR Code com CRC malformado');
  }
  if (brCodeCrc16(payloadWithoutCrc) !== expectedCrc.toUpperCase()) {
    throw new BrCodeError('QR Code Pix adulterado (CRC invalido)');
  }

  const tags = parseTags(raw);
  const accountInfo = tags.get('26');
  if (!accountInfo) {
    throw new BrCodeError('BR Code sem chave Pix');
  }
  const accountTags = parseTemplate(accountInfo);
  const key = accountTags.get('01');
  if (!key || key.trim().length === 0) {
    throw new BrCodeError('BR Code sem chave Pix');
  }

  const currency = tags.get('53');
  if (currency && currency !== '986') {
    throw new BrCodeError('QR Code em moeda nao suportada');
  }

  const additionalData = tags.get('62');
  const additionalTags = additionalData ? parseTemplate(additionalData) : new Map<string, string>();

  return {
    key: key.trim(),
    keyType: guessPixKeyType(key) ?? null,
    amount: tags.get('54')?.trim() || null,
    merchantName: tags.get('59')?.trim() || null,
    city: tags.get('60')?.trim() || null,
    country: tags.get('58')?.trim() || null,
    txid: additionalTags.get('05')?.trim() || null,
    raw,
  };
}

/** `true` quando o payload e um BR Code valido. */
export function isValidBrCode(payload: string): boolean {
  try {
    parseBrCode(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mascara a chave Pix para exibicao: o e-mail mantem o dominio, o resto fica
 * com o miolo trocado.
 */
export function maskPixKey(key: string): string {
  if (key.includes('@')) {
    const [user = '', domain = ''] = key.split('@');
    if (!domain) return key;
    return `${user.slice(0, 1)}•@${domain}`;
  }
  if (key.length <= 4) return key;
  return `${key.slice(0, 2)}${'•'.repeat(Math.max(1, key.length - 4))}${key.slice(-2)}`;
}

/** Tag EMV: `id` (2) + `len` (2) + valor. */
function buildTag(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/**
 * Monta um BR Code (QR Code do Pix) para uma chave Pix.
 *
 * O motor monta o codigo no trilho "Pix direto": o usuario configura a chave
 * Pix da propria conta e o pagamento cai la, sem passar pela LuniumPay e sem
 * conversao. O `txid` amarra o codigo ao pedido — e o que permite reconciliar
 * depois (quando ha um provedor que avisa).
 *
 * O `txid` do padrao EMV aceita ate 25 caracteres alfanumericos; qualquer
 * coisa fora disso e removida, porque um caractere especial quebra a leitura
 * de alguns aplicativo de banco.
 */
export function buildBrCode(options: {
  key: string;
  merchantName?: string;
  city?: string;
  amount?: string;
  txid?: string;
}): string {
  const key = options.key.trim();
  if (key.length === 0) {
    throw new BrCodeError('chave Pix vazia');
  }
  const accountInfo = buildTag('00', 'br.gov.bcb.pix') + buildTag('01', key);
  const merchantName = (options.merchantName ?? 'MERCHANT')
    .slice(0, 25)
    .replace(/[^\p{L}\p{N} ]/gu, '');
  const city = (options.city ?? 'SAO PAULO').slice(0, 15).replace(/[^\p{L}\p{N} ]/gu, '');
  const txid = (options.txid ?? '***')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 25);

  const parts = [
    BR_CODE_PREFIX,
    buildTag('00', '01'),
    buildTag('26', accountInfo),
    buildTag('52', '0000'),
    buildTag('53', '986'),
    options.amount ? buildTag('54', options.amount) : '',
    buildTag('58', 'BR'),
    buildTag('59', merchantName),
    buildTag('60', city),
    buildTag('62', buildTag('05', txid)),
  ].filter((part) => part.length > 0);

  const withoutCrc = parts.join('');
  return `${withoutCrc}6304${brCodeCrc16(`${withoutCrc}6304`)}`;
}

