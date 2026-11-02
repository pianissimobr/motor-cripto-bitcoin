import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  isStrongEnoughPassword,
  verifyPassword,
} from '../src/crypto/password.js';
import { generateOpaqueToken, hashOpaqueToken } from '../src/crypto/token.js';

describe('password (scrypt)', () => {
  it('hash and verify round-trip', () => {
    const encoded = hashPassword('senha-forte-123');
    expect(encoded.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('senha-forte-123', encoded)).toBe(true);
    expect(verifyPassword('senha-errada', encoded)).toBe(false);
  });

  it('rejects malformed encodings', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$1$r$p$salt$key')).toBe(false);
  });

  it('enforces strength', () => {
    expect(isStrongEnoughPassword('curta')).toBe(false);
    expect(isStrongEnoughPassword('a'.repeat(8))).toBe(true);
  });
});

describe('token (opaque)', () => {
  it('generates distinct tokens and stable hashes', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(hashOpaqueToken(a)).toBe(hashOpaqueToken(a));
    expect(hashOpaqueToken(a)).not.toBe(hashOpaqueToken(b));
  });
});