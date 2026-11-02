import { HDNodeWallet, Mnemonic } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { HdWallet } from '../src/core/hd/hd-wallet.js';
import { silentLogger } from '../src/core/logger.js';
import { createProcessSigner } from '../src/bootstrap.js';
import { LocalSigner } from '../src/core/signer/local-signer.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const MNEMONIC = 'test test test test test test test test test test test junk';

function config() {
  const account = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), "m/44'/60'/0'");
  return {
    loaded: loadConfig({
      ADMIN_TOKEN: 'a'.repeat(32),
      DATABASE_URL: 'postgres://motor:senha@localhost:5432/motor',
      DATA_ENCRYPTION_KEY: KEY,
      HD_XPUB: account.neuter().extendedKey,
      SIGNER_MODE: 'local',
      SIGNER_PASSPHRASE: 'segredo-longo',
      GAS_SPONSOR_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    }),
    xpub: account.neuter().extendedKey,
  };
}

describe('signer por papel', () => {
  it('a API nao abre o keystore e recusa assinar', async () => {
    const spy = vi.spyOn(LocalSigner, 'fromKeystoreFile');
    const { loaded, xpub } = config();
    const hd = HdWallet.fromAccountXpub(xpub, '0', 0);
    const signer = createProcessSigner('api', loaded, hd, silentLogger);

    expect(spy).not.toHaveBeenCalled();
    expect(signer.addressFor(0)).toBe(hd.deriveAddress(0));
    await expect(
      signer.signTransfer({
        index: 0,
        to: `0x${'11'.repeat(20)}`,
        data: '0x',
        value: 0n,
        chainId: 137,
        nonce: 0,
        gasLimit: 21_000n,
      }),
    ).rejects.toThrow(/nao assina/);
    spy.mockRestore();
  });
});
