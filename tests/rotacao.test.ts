import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { BlindIndex, DataCipher, DecryptionError, Keyring } from '../src/core/crypto/cipher.js';

/**
 * Frente E - rotacao de chaves.
 *
 * E1: envelope v2 carrega o `kid` da chave que cifrou o dado.
 * E2: o keyring mantem varias chaves; a antiga ainda abre o que ja existe.
 * E3: o blind index tem versao; durante a rotacao a busca consulta as duas.
 * E5: round-trip v1 <-> v2 sem perder dado.
 */

const key1 = randomBytes(32);
const key2 = randomBytes(32);
const AAD = 'cliente-uuid-123';

describe('E1: envelope versionado com kid', () => {
  const cipher = new DataCipher(new Keyring({ k1: key1, k2: key2 }, 'k2', 'k1'));

  it('grava v2 com o kid da chave ativa', () => {
    const blob = cipher.encrypt('maria@example.com', AAD);
    expect(blob[0]).toBe(2);
    expect(cipher.kidOf(blob)).toBe('k2');
  });

  it('o kid no cabecalho e o do keyring ativo', () => {
    const comK1 = new DataCipher(new Keyring({ k1: key1 }, 'k1'));
    expect(comK1.kidOf(comK1.encrypt('x', AAD))).toBe('k1');
  });

  it('o IV continua unico por registro', () => {
    const a = cipher.encrypt('mesmo', AAD);
    const b = cipher.encrypt('mesmo', AAD);
    expect(a.equals(b)).toBe(false);
  });

  it('recusa chave ativa inexistente', () => {
    expect(() => new Keyring({ k1: key1 }, 'k9', 'k1').assertValid()).toThrow(/nao existe/);
  });

  it('recusa chave de tamanho errado', () => {
    expect(() => new Keyring({ k1: randomBytes(16) }, 'k1').assertValid()).toThrow(/32 bytes/);
  });

  it('recusa keyring vazio', () => {
    expect(() => new Keyring({}, 'k1').assertValid()).toThrow(/vazio/);
  });

  it('recusa kid longo demais', () => {
    const longo = 'x'.repeat(300);
    const c = new DataCipher(new Keyring({ [longo]: key1 }, longo));
    expect(() => c.encrypt('x', AAD)).toThrow(/kid longo/);
  });
});

describe('E2: keyring com varias chaves', () => {
  it('abre com a chave correta de cada kid', () => {
    const ring = { k1: key1, k2: key2, k3: randomBytes(32) };
    const c1 = new DataCipher(new Keyring(ring, 'k1', 'k1'));
    const c2 = new DataCipher(new Keyring(ring, 'k2', 'k1'));
    const c3 = new DataCipher(new Keyring(ring, 'k3', 'k1'));

    expect(c1.decrypt(c1.encrypt('a', AAD), AAD)).toBe('a');
    expect(c2.decrypt(c2.encrypt('b', AAD), AAD)).toBe('b');
    expect(c3.decrypt(c3.encrypt('c', AAD), AAD)).toBe('c');
  });

  it('chaves diferentes nao abrem o mesmo envelope', () => {
    const c1 = new DataCipher(new Keyring({ k1: key1 }, 'k1'));
    const c2 = new DataCipher(new Keyring({ k2: key2 }, 'k2'));
    const blob = c1.encrypt('segredo', AAD);
    // k2 nao tem k1 no keyring -> erro explicito, nao fallback silencioso.
    expect(() => c2.decrypt(blob, AAD)).toThrow(/ausente do keyring/);
  });

  it('falta de chave e erro explicito, nunca leitura errada', () => {
    const soK1 = new DataCipher(new Keyring({ k1: key1 }, 'k1'));
    const blob = soK1.encrypt('segredo', AAD);
    const semK1 = new DataCipher(new Keyring({ k2: key2 }, 'k2'));
    expect(() => semK1.decrypt(blob, AAD)).toThrow(DecryptionError);
  });
});

describe('E5: round-trip v1 <-> v2', () => {
  /** Envelope v1 original: [1][iv][tag][ct] */
  function legacyEncrypt(plaintext: string, key: Buffer, aad: string): Buffer {
    // Reimplementa o v1 para simular dado gravado antes da rotacao.
    const { createCipheriv, randomBytes } = require('node:crypto') as typeof import('node:crypto');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
  }

  it('abre envelope v1 usando a chave legada', () => {
    const antigo = legacyEncrypt('maria@example.com', key1, AAD);
    const cipher = new DataCipher(new Keyring({ k1: key1, k2: key2 }, 'k2', 'k1'));
    expect(cipher.decrypt(antigo, AAD)).toBe('maria@example.com');
  });

  it('envelope v1 e reconhecido como sem kid', () => {
    const antigo = legacyEncrypt('x', key1, AAD);
    const cipher = new DataCipher(new Keyring({ k1: key1, k2: key2 }, 'k2', 'k1'));
    expect(cipher.kidOf(antigo)).toBe('v1-sem-kid');
  });

  it('v1 com a chave legada errada falha', () => {
    const antigo = legacyEncrypt('x', key1, AAD);
    const cipher = new DataCipher(new Keyring({ k2: key2 }, 'k2', 'k2'));
    expect(() => cipher.decrypt(antigo, AAD)).toThrow(DecryptionError);
  });

  it('re-cifra preservando o valor', () => {
    const cipher = new DataCipher(new Keyring({ k1: key1, k2: key2 }, 'k1', 'k1'));
    const antigo = legacyEncrypt('Joao Silva', key1, AAD);
    const valor = cipher.decrypt(antigo, AAD);

    // o "rotate-keys" re-cifra com a chave ativa
    const rotacionado = new DataCipher(new Keyring({ k1: key1, k2: key2 }, 'k2', 'k1'));
    const novo = rotacionado.encrypt(valor, AAD);
    expect(novo[0]).toBe(2);
    expect(rotacionado.decrypt(novo, AAD)).toBe('Joao Silva');
  });

  it('so aceita o dado com o AAD certo em v1 e v2', () => {
    const c = new DataCipher(new Keyring({ k1: key1, k2: key2 }, 'k2', 'k1'));
    for (const blob of [legacyEncrypt('x', key1, AAD), c.encrypt('x', AAD)]) {
      expect(() => c.decrypt(blob, 'outro-aad')).toThrow(DecryptionError);
    }
  });

  it('recusa blob truncado', () => {
    const c = new DataCipher(new Keyring({ k1: key1 }, 'k1'));
    expect(() => c.decrypt(Buffer.alloc(4), AAD)).toThrow(/truncado/);
  });

  it('recusa versao desconhecida', () => {
    const c = new DataCipher(new Keyring({ k1: key1 }, 'k1'));
    const blob = Buffer.concat([Buffer.from([9]), randomBytes(40)]);
    expect(() => c.decrypt(blob, AAD)).toThrow(/nao suportada/);
  });
});

describe('E3: blind index versionado', () => {
  const idx1 = new BlindIndex(key1, 'k1');

  it('computa com a chave ativa', () => {
    expect(idx1.compute('a@b.com')).toBe(idx1.hashWith('k1', 'a@b.com'));
  });

  it('em rotacao produz dois indices para o mesmo valor', () => {
    const rot = BlindIndex.rotating(key2, 'v2', key1, 'k1');
    const todos = rot.computeAll('a@b.com');
    expect(todos).toHaveLength(2);
    expect(todos[0]?.bidx).not.toBe(todos[1]?.bidx);
  });

  it('o valor ativo e o da chave nova', () => {
    const rot = BlindIndex.rotating(key2, 'v2', key1, 'k1');
    expect(rot.compute('a@b.com')).toBe(rot.hashWith('v2', 'a@b.com'));
  });

  it('a chave antiga ainda produz o indice anterior', () => {
    const rot = BlindIndex.rotating(key2, 'v2', key1, 'k1');
    expect(rot.hashWith('k1', 'a@b.com')).toBe(idx1.compute('a@b.com'));
  });

  it('um index so produz um indice', () => {
    expect(idx1.computeAll('a@b.com')).toHaveLength(1);
  });

  it('recusa chave de tamanho errado', () => {
    expect(() => new BlindIndex(randomBytes(16))).toThrow(/32 bytes/);
  });

  it('recusa kid ausente', () => {
    const rot = BlindIndex.rotating(key2, 'v2', key1, 'k1');
    expect(() => rot.hashWith('inexistente', 'a')).toThrow(/ausente/);
  });

  it('os dois indices sao deterministicos e diferentes entre si', () => {
    const rot = BlindIndex.rotating(key2, 'v2', key1, 'k1');
    const a = rot.computeAll('maria@example.com');
    const b = rot.computeAll('maria@example.com');
    expect(a[0]?.bidx).toBe(b[0]?.bidx);
    expect(a[0]?.bidx).not.toBe(a[1]?.bidx);
  });
});