import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type CanonicalRequest = {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
};

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Blind index determinista (HMAC) para busca exata de valor de baixa entropia
 * (ex.: CPF/CNPJ) sem expor o valor cru e sem permitir brute force so com a
 * leitura do banco.
 */
export function blindIndex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function buildCanonicalRequest(input: CanonicalRequest): string {
  const method = input.method.toUpperCase();
  const path = input.path.split('?')[0]!;
  return [
    method,
    path,
    input.timestamp,
    input.nonce,
    sha256Hex(input.body),
  ].join('\n');
}

export function signRequest(secret: string, input: CanonicalRequest): string {
  return hmacSha256Hex(secret, buildCanonicalRequest(input));
}

export function verifyRequestSignature(
  secret: string,
  input: CanonicalRequest,
  signature: string,
): boolean {
  const expected = signRequest(secret, input);
  return timingSafeEqualHex(expected, signature.replace(/^v1=/, ''));
}

/** Assinatura de webhook no formato `t=<unix>,v1=<hex>`. */
export function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): string {
  const v1 = hmacSha256Hex(secret, `${timestamp}.${body}`);
  return `t=${timestamp},v1=${v1}`;
}

export type ParsedWebhookSignature = {
  timestamp: number;
  v1: string;
};

export function parseWebhookSignature(
  header: string,
): ParsedWebhookSignature | null {
  const parts = header.split(',').map((part) => part.trim());
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't' && value) timestamp = Number(value);
    if (key === 'v1' && value) v1 = value;
  }
  if (timestamp === null || !Number.isInteger(timestamp) || !v1) return null;
  return { timestamp, v1 };
}

export function verifyWebhookSignature(input: {
  secret: string;
  header: string;
  body: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const parsed = parseWebhookSignature(input.header);
  if (!parsed) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) return false;
  const expected = hmacSha256Hex(
    input.secret,
    `${parsed.timestamp}.${input.body}`,
  );
  return timingSafeEqualHex(expected, parsed.v1);
}
