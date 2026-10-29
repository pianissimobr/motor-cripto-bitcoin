import { createHash } from 'node:crypto';
import { base58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { describe, expect, it } from 'vitest';
import {
  assertAddress,
  deriveAddress,
  HdWalletError,
  parseAccountXpub,
  validateAddress,
} from '../src/adapters/hd/derivation.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const coder = base58check((data) =>
  createHash('sha256').update(data).digest(),
);

function withVersion(extended: string, version: number): string {
  const raw = Buffer.from(coder.decode(extended));
  raw.writeUInt32BE(version, 0);
  return coder.encode(raw);
}

const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const account = root.derive("m/84'/0'/0'");
const xpub = account.publicExtendedKey;
const tpub = withVersion(xpub, 0x043587cf);
const zpub = withVersion(xpub, 0x04b24746);

describe('hd derivation', () => {
  it('deriva o primeiro endereco BIP84 mainnet do vetor de teste', () => {
    const parsed = parseAccountXpub(xpub, 'bitcoin');
    const derived = deriveAddress(parsed, 0, 'bitcoin');
    expect(derived.address).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
    expect(derived.path).toBe('m/0/0');
    expect(parsed.fingerprint).toHaveLength(16);
  });

  it('aceita zpub e normaliza para a mesma conta', () => {
    const parsed = parseAccountXpub(zpub, 'bitcoin');
    expect(deriveAddress(parsed, 0, 'bitcoin').address).toBe(
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    );
  });

  it('deriva testnet e regtest a partir do tpub', () => {
    const parsed = parseAccountXpub(tpub, 'testnet');
    expect(deriveAddress(parsed, 0, 'testnet').address).toBe(
      'tb1qcr8te4kr609gcawutmrza0j4xv80jy8zmfp6l0',
    );
    expect(deriveAddress(parsed, 0, 'regtest').address).toBe(
      'bcrt1qcr8te4kr609gcawutmrza0j4xv80jy8zeqchgx',
    );
  });

  it('rejeita xpub de rede errada', () => {
    expect(() => parseAccountXpub(xpub, 'regtest')).toThrow(HdWalletError);
    expect(() => parseAccountXpub(tpub, 'bitcoin')).toThrow(HdWalletError);
  });

  it('rejeita xpub master e chave privada', () => {
    expect(() =>
      parseAccountXpub(root.publicExtendedKey, 'bitcoin'),
    ).toThrow(/depth 0/);
    expect(() =>
      parseAccountXpub(account.privateExtendedKey, 'bitcoin'),
    ).toThrow(HdWalletError);
  });

  it('valida enderecos por rede', () => {
    expect(
      validateAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'bitcoin'),
    ).toBe(true);
    expect(
      validateAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'testnet'),
    ).toBe(false);
    expect(() =>
      assertAddress('invalido', 'bitcoin'),
    ).toThrow(HdWalletError);
  });
});
