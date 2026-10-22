import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress, HDNodeWallet, Mnemonic } from 'ethers';
import {
  assertSignTransferInput,
  InvalidSignTransfer,
  ManualSigningRequired,
  type SignTransferInput,
} from '../src/core/signer/signer.js';
import { PsbtSigner } from '../src/core/signer/psbt-signer.js';
import { RemoteSigner } from '../src/core/signer/remote-signer.js';
import { LocalSigner } from '../src/core/signer/local-signer.js';
import { HdWallet } from '../src/core/hd/hd-wallet.js';

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const MNEMONIC = 'test test test test test test test test test test test junk';
const ACCOUNT_PATH = "m/44'/60'/0'";

function input(overrides: Partial<SignTransferInput> = {}): SignTransferInput {
  return {
    index: 0,
    to: TO,
    data: '0x',
    value: 0n,
    chainId: 137,
    nonce: 1,
    gasLimit: 21_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    ...overrides,
  };
}

describe('P1: validacao de entrada do signer', () => {
  it('aceita um transfer valido', () => {
    expect(() => assertSignTransferInput(input())).not.toThrow();
  });

  it.each([
    ['chainId 0', { chainId: 0 }],
    ['nonce negativo', { nonce: -1 }],
    ['gasLimit zero', { gasLimit: 0n }],
    ['index negativo', { index: -1 }],
    ['value negativo', { value: -1n }],
    ['destino invalido', { to: '0x123' }],
    ['data nao-hex', { data: 'zz' }],
    ['priority > maxFee', { maxPriorityFeePerGas: 31_000_000_000n }],
  ])('rejeita %s', (_nome, override) => {
    expect(() => assertSignTransferInput(input(override))).toThrow(InvalidSignTransfer);
  });
});

describe('P1: PSBT fail-fast', () => {
  it('lanca ManualSigningRequired com a transacao real', async () => {
    const signer = new PsbtSigner(() => FROM);
    const resp = signer.signTransfer(input());
    await expect(resp).rejects.toBeInstanceOf(ManualSigningRequired);

    try {
      await resp;
    } catch (err) {
      const unsigned = (err as ManualSigningRequired).unsigned;
      expect(unsigned.from).toBe(getAddress(FROM));
      expect(unsigned.to).toBe(getAddress(TO));
      expect(unsigned.chainId).toBe(137);
      expect(unsigned.nonce).toBe(1);
      expect(unsigned.gasLimit).toBe('21000');
    }
  });

  it('rejeita input invalido antes de montar a unsigned', () => {
    const signer = new PsbtSigner(() => FROM);
    expect(() => signer.buildUnsigned(input({ chainId: 0 }))).toThrow(InvalidSignTransfer);
  });
});

describe('P1: RemoteSigner valida a resposta', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('nao chama o servico com input invalido', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const signer = new RemoteSigner({ url: 'https://signer.local', resolveAddress: () => FROM });

    await expect(signer.signTransfer(input({ chainId: 0 }))).rejects.toThrow(
      InvalidSignTransfer,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejeita rawTransaction que nao e hex', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ rawTransaction: 'nao-hex' }), { status: 200 })),
    );
    const signer = new RemoteSigner({ url: 'https://signer.local', resolveAddress: () => FROM });

    await expect(signer.signTransfer(input())).rejects.toThrow(/rawTransaction invalido/);
  });
});

describe('P1: LocalSigner confere a conta HD', () => {
  const account = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), ACCOUNT_PATH);
  const xpub = account.neuter().extendedKey;
  const xprv = account.extendedKey;

  it('aceita xpub e xprv da mesma conta', () => {
    const signer = LocalSigner.fromXprv(xprv);
    expect(() => signer.verifyMatches(HdWallet.fromAccountXpub(xpub))).not.toThrow();
  });

  it('rejeita xpub de outra carteira', () => {
    const outra = HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
      ACCOUNT_PATH,
    );
    const signer = LocalSigner.fromXprv(xprv);
    expect(() =>
      signer.verifyMatches(HdWallet.fromAccountXpub(outra.neuter().extendedKey)),
    ).toThrow(/nao corresponde/);
  });

  it('rejeita prefixo/conta diferentes', () => {
    const signer = LocalSigner.fromXprv(xprv);
    expect(() =>
      signer.verifyMatches(HdWallet.fromAccountXpub(xpub, '1', 0)),
    ).toThrow(/nao corresponde/);
    expect(() =>
      signer.verifyMatches(HdWallet.fromAccountXpub(xpub, '0', 1)),
    ).toThrow(/nao corresponde/);
  });
});

describe('P1: RemoteSigner confere o raw assinado', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function servico(wallet: HDNodeWallet, raw: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ rawTransaction: raw }), { status: 200 })),
    );
    return new RemoteSigner({
      url: 'https://signer.local',
      resolveAddress: () => wallet.address,
    });
  }

  async function assinar(wallet: HDNodeWallet, overrides: Partial<SignTransferInput> = {}) {
    const i = input(overrides);
    return wallet.signTransaction({
      to: i.to,
      data: i.data,
      value: i.value,
      chainId: i.chainId,
      nonce: i.nonce,
      gasLimit: i.gasLimit,
      type: 2,
      maxFeePerGas: i.maxFeePerGas,
      maxPriorityFeePerGas: i.maxPriorityFeePerGas,
    });
  }

  it('aceita raw que corresponde exatamente a solicitacao', async () => {
    const wallet = HDNodeWallet.createRandom();
    const raw = await assinar(wallet);
    const signer = await servico(wallet, raw);
    const signed = await signer.signTransfer(input());
    expect(signed.rawTransaction).toBe(raw);
  });

  it('rejeita destino trocado pelo signer remoto', async () => {
    const wallet = HDNodeWallet.createRandom();
    const raw = await assinar(wallet, { to: '0x3333333333333333333333333333333333333333' });
    const signer = await servico(wallet, raw);
    await expect(signer.signTransfer(input())).rejects.toThrow(/destino/);
  });

  it('rejeita valor trocado pelo signer remoto', async () => {
    const wallet = HDNodeWallet.createRandom();
    const raw = await assinar(wallet, { value: 1n });
    const signer = await servico(wallet, raw);
    await expect(signer.signTransfer(input())).rejects.toThrow(/value/);
  });

  it('rejeita remetente de outro indice', async () => {
    const wallet = HDNodeWallet.createRandom();
    const raw = await assinar(wallet);
    const signer = await servico(HDNodeWallet.createRandom(), raw);
    await expect(signer.signTransfer(input())).rejects.toThrow(/remetente/);
  });
});
