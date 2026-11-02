import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptKeystore, decryptKeystore, safeEqual } from '../src/core/hd/keystore.js';

describe('keystore', () => {
  const payload = {
    xprv: 'xprv-teste-nao-real',
    accountIndex: 0,
    derivationPrefix: '0',
  };

  it('cifra e decifra com a senha correta', () => {
    const file = encryptKeystore(payload, 'senha-forte-123');
    expect(file.kdf).toBe('scrypt');
    expect(file.ciphertext).not.toContain('xprv-teste-nao-real');
    const decrypted = decryptKeystore(file, 'senha-forte-123');
    expect(decrypted.xprv).toBe(payload.xprv);
  });

  it('recusa senha errada', () => {
    const file = encryptKeystore(payload, 'senha-forte-123');
    expect(() => decryptKeystore(file, 'senha-errada')).toThrow(/senha incorreta/);
  });

  it('usa salt aleatorio por arquivo', () => {
    const a = encryptKeystore(payload, 'senha-forte-123');
    const b = encryptKeystore(payload, 'senha-forte-123');
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('recusa senha curta demais', () => {
    expect(() => encryptKeystore(payload, 'curta')).toThrow(/8 caracteres/);
  });
});

describe('safeEqual', () => {
  it('compara tokens corretamente', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('randomBytes', () => {
  it('produz material distinto', () => {
    expect(randomBytes(32).equals(randomBytes(32))).toBe(false);
  });
});
