import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'ethers';
import {
  assertSignTransferInput,
  InvalidSignTransfer,
  ManualSigningRequired,
  type SignTransferInput,
} from '../src/core/signer/signer.js';
import { PsbtSigner } from '../src/core/signer/psbt-signer.js';
import { RemoteSigner } from '../src/core/signer/remote-signer.js';

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';

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
