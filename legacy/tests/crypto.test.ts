import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DataCipher, BlindIndex, DecryptionError } from '../src/core/crypto/cipher.js';
import { maskEmail, maskName, normalizeEmail } from '../src/core/crypto/mask.js';

describe('DataCipher', () => {
  const key = randomBytes(32);
  const cipher = new DataCipher(key);

  it('cifra e decifra preservando o valor', () => {
    const blob = cipher.encrypt('maria@example.com', 'id-1');
    expect(cipher.decrypt(blob, 'id-1')).toBe('maria@example.com');
  });

  it('gera IV aleatorio por registro (mesmo texto vira blobs diferentes)', () => {
    const a = cipher.encrypt('mesmo', 'id-1');
    const b = cipher.encrypt('mesmo', 'id-1');
    expect(a.equals(b)).toBe(false);
  });

  it('recusa decifrar com outro AAD (troca de ciphertext entre linhas)', () => {
    const blob = cipher.encrypt('segredo', 'id-1');
    expect(() => cipher.decrypt(blob, 'id-2')).toThrow(DecryptionError);
  });

  it('recusa decifrar com a chave errada', () => {
    const blob = cipher.encrypt('segredo', 'id-1');
    const outro = new DataCipher(randomBytes(32));
    expect(() => outro.decrypt(blob, 'id-1')).toThrow(DecryptionError);
  });

  it('detecta adulteracao do ciphertext', () => {
    const blob = cipher.encrypt('segredo', 'id-1');
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(blob, 'id-1')).toThrow(DecryptionError);
  });

  it('recusa chave de tamanho errado', () => {
    expect(() => new DataCipher(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe('BlindIndex', () => {
  const index = new BlindIndex(randomBytes(32));

  it('e deterministico para o mesmo valor', () => {
    expect(index.compute('a@b.com')).toBe(index.compute('a@b.com'));
  });

  it('diferente para valores diferentes', () => {
    expect(index.compute('a@b.com')).not.toBe(index.compute('c@d.com'));
  });

  it('nao expoe o valor original', () => {
    expect(index.compute('a@b.com')).not.toContain('a@b.com');
    expect(index.compute('a@b.com')).toHaveLength(64);
  });
});

describe('mascaras', () => {
  it('mascara email preservando dominio', () => {
    expect(maskEmail('joao.silva@example.com')).toBe('j***@e***.com');
  });

  it('mascara nome', () => {
    expect(maskName('Joao Silva')).toBe('J*** S***');
  });

  it('normaliza email', () => {
    expect(normalizeEmail('  Maria@Example.COM ')).toBe('maria@example.com');
  });
});
