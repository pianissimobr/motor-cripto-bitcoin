import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 1 << 15;
const r = 8;
const p = 1;
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

/** Hash de senha de login. Nunca guarde a senha em claro. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, KEY_LEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, nRaw, rRaw, pRaw, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !nRaw || !rRaw || !pRaw || !saltB64 || !hashB64) return false;
  const n = Number(nRaw);
  const rounds = Number(rRaw);
  const parallel = Number(pRaw);
  if (!Number.isInteger(n) || n < 2 || n > 1 << 16) return false;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 32) return false;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r: rounds,
    p: parallel,
    maxmem: MAXMEM,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
