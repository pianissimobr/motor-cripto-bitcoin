import { describe, expect, it } from 'vitest';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { HdWallet, HdWalletError } from '../src/core/hd/hd-wallet.js';

/**
 * Vetor de teste fixo (mnemonic de teste publica do ethers).
 * Serve para provar que a derivacao via xpub de CONTA produz exatamente os
 * mesmos endereces que a derivacao via xprv/seed.
 */
const MNEMONIC =
  'test test test test test test test test test test test junk';
const ACCOUNT_PATH = "m/44'/60'/0'";

describe('HdWallet', () => {
  const accountNode = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(MNEMONIC),
    ACCOUNT_PATH,
  );
  const xpub = accountNode.neuter().extendedKey;
  const xprv = accountNode.extendedKey;

  it('deriva os mesmos enderecos via xpub e via xprv', () => {
    const viaPub = HdWallet.fromAccountXpub(xpub, '0', 0);
    const viaPriv = HdWallet.fromAccountXprv(xprv, '0', 0);

    for (const index of [0, 1, 2, 7, 42, 999]) {
      expect(viaPub.deriveAddress(index).toLowerCase()).toBe(
        viaPriv.deriveAddress(index).toLowerCase(),
      );
    }
  });

  it('bate com o caminho BIP44 completo m/44\'/60\'/0\'/0/{index}', () => {
    const viaPub = HdWallet.fromAccountXpub(xpub, '0', 0);
    for (const index of [0, 5, 13]) {
      const esperado = HDNodeWallet.fromMnemonic(
        Mnemonic.fromPhrase(MNEMONIC),
        `m/44'/60'/0'/0/${index}`,
      ).address;
      expect(viaPub.deriveAddress(index)).toBe(esperado);
    }
  });

  it('rejeita xprv no lugar do xpub', () => {
    expect(() => HdWallet.fromAccountXpub(xprv)).toThrow(HdWalletError);
    expect(() => HdWallet.fromAccountXpub(xprv)).toThrow(/Nunca use xprv/);
  });

  it('rejeita xpub master com explicacao sobre passos hardened', () => {
    const master = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), 'm');
    const masterXpub = master.neuter().extendedKey;
    expect(() => HdWallet.fromAccountXpub(masterXpub)).toThrow(/depth 0/);
    expect(() => HdWallet.fromAccountXpub(masterXpub)).toThrow(/hardened/);
  });

  it('rejeita xpub de folha (depth 5) orientando usar o de conta', () => {
    const leaf = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC));
    expect(() => HdWallet.fromAccountXpub(leaf.neuter().extendedKey)).toThrow(/depth 5/);
  });

  it('rejeita prefixo de derivacao hardened', () => {
    expect(() => HdWallet.fromAccountXpub(xpub, "0'")).toThrow(/hardened/);
  });

  it('rejeita indice invalido', () => {
    const wallet = HdWallet.fromAccountXpub(xpub, '0', 0);
    expect(() => wallet.deriveAddress(-1)).toThrow();
    expect(() => wallet.deriveAddress(1.5)).toThrow();
  });

  it('nao expoe chave privada a partir do xpub', () => {
    const viaPub = HdWallet.fromAccountXpub(xpub, '0', 0);
    expect(() => viaPub.derivePrivateKey(0)).toThrow(/chave privada/);
  });

  it('monta o caminho completo para auditoria', () => {
    const wallet = HdWallet.fromAccountXpub(xpub, '0', 0);
    expect(wallet.fullPath(12)).toBe("m/44'/60'/0'/0/12");
  });
});
