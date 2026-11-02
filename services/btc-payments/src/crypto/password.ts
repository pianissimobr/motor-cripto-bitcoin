import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 1 << 17;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAXMEM = 512 * 1024 * 1024;

/** Limites de defesa para parâmetros vindos de um hash armazenado. */
const MAX_N = 1 << 18;
const MAX_R = 64;
const MAX_P = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(password.normalize('NFKC'), salt, KEY_LEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4];
  const keyB64 = parts[5];
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < 2 ||
    r < 1 ||
    p < 1 ||
    n > MAX_N ||
    r > MAX_R ||
    p > MAX_P ||
    !saltB64 ||
    !keyB64
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    if (expected.length !== KEY_LEN) return false;
    const key = scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export function isStrongEnoughPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}