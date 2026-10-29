import { describe, expect, it } from 'vitest';
import {
  decryptKeystore,
  encryptKeystore,
  KeystoreError,
} from '../src/adapters/signer/keystore.js';

const payload = {
  xprv: 'tprv-test-vector',
  accountIndex: 0,
  derivationPrefix: '0',
  network: 'regtest' as const,
};

describe('keystore', () => {
  it('cifra e decifra o payload', () => {
    const file = encryptKeystore(payload, 'senha-de-teste-123');
    expect(file.ciphertext).not.toContain(payload.xprv);
    expect(decryptKeystore(file, 'senha-de-teste-123')).toEqual(payload);
  });

  it('rejeita senha errada', () => {
    const file = encryptKeystore(payload, 'senha-de-teste-123');
    expect(() => decryptKeystore(file, 'senha-errada-123')).toThrow(KeystoreError);
  });

  it('rejeita senha curta', () => {
    expect(() => encryptKeystore(payload, 'curta')).toThrow(KeystoreError);
  });
});
