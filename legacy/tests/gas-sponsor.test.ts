import { Wallet, keccak256, type Provider } from 'ethers';
import { describe, expect, it } from 'vitest';
import { GasSponsor } from '../src/core/chain/gas-sponsor.js';

const KEY = `0x${'11'.repeat(32)}`;

function harness() {
  const sponsor = new Wallet(KEY);
  const dest = `0x${'22'.repeat(20)}`;
  const balances = new Map<string, bigint>([
    [sponsor.address.toLowerCase(), 10n ** 18n],
    [dest.toLowerCase(), 0n],
  ]);
  const receipts = new Map<string, { status: number }>();
  let release = false;
  const broadcasts: string[] = [];

  const provider = {
    network: { chainId: 137n },
    getNetwork: async () => ({ chainId: 137n, name: 'polygon' }),
    getBalance: async (addr: string) => balances.get(addr.toLowerCase()) ?? 0n,
    estimateGas: async () => 21_000n,
    getTransactionCount: async () => 0,
    getFeeData: async () => ({
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 1n,
    }),
    getTransactionReceipt: async (hash: string) => (release ? (receipts.get(hash) ?? null) : null),
    broadcastTransaction: async (raw: string) => {
      broadcasts.push(raw);
      const hash = keccak256(raw);
      receipts.set(hash, { status: 1 });
      balances.set(sponsor.address.toLowerCase(), (balances.get(sponsor.address.toLowerCase()) ?? 0n) - 1n);
      return {
        hash,
        wait: async () => (release ? { status: 1 } : null),
      };
    },
  } as unknown as Provider;

  return {
    provider,
    broadcasts,
    dest,
    balances,
    sponsorAddress: sponsor.address,
    setRelease(value: boolean) {
      release = value;
    },
  };
}

describe('GasSponsor', () => {
  it('envia com o provider conectado e nao reenvia enquanto o recibo nao chega', async () => {
    const chain = harness();
    const sponsor = GasSponsor.fromPrivateKey(KEY, 5n, 1n, chain.sponsorAddress);
    expect(sponsor.enabled).toBe(true);

    const primeiro = await sponsor.ensureGas(chain.provider, chain.dest, { maxFeePerGas: 1n });
    expect(primeiro).toBe(true);
    expect(chain.broadcasts).toHaveLength(1);

    const segundo = await sponsor.ensureGas(chain.provider, chain.dest, { maxFeePerGas: 1n });
    expect(segundo).toBe(false);
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('nao reenvia depois do recibo se o saldo passou do piso', async () => {
    const chain = harness();
    const sponsor = GasSponsor.fromPrivateKey(KEY, 5n, 1n);
    await sponsor.ensureGas(chain.provider, chain.dest, { maxFeePerGas: 1n });

    chain.setRelease(true);
    chain.balances.set(chain.dest.toLowerCase(), 5n);
    const deNovo = await sponsor.ensureGas(chain.provider, chain.dest, { maxFeePerGas: 1n });
    expect(deNovo).toBe(false);
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('reenvia so se o recibo de sucesso deixou o saldo abaixo do piso', async () => {
    const chain = harness();
    const sponsor = GasSponsor.fromPrivateKey(KEY, 5n, 1n);
    await sponsor.ensureGas(chain.provider, chain.dest, { maxFeePerGas: 1n });
    chain.setRelease(true);

    const deNovo = await sponsor.ensureGas(chain.provider, chain.dest, { maxFeePerGas: 1n });
    expect(deNovo).toBe(true);
    expect(chain.broadcasts).toHaveLength(2);
  });

  it('watchOnly consulta saldo e nao assina', async () => {
    const chain = harness();
    const sponsor = GasSponsor.watchOnly(chain.sponsorAddress, 5n, 1n);
    expect(sponsor.enabled).toBe(false);
    expect(sponsor.configured).toBe(true);
    expect(await sponsor.balance(chain.provider)).toBe(10n ** 18n);
    expect(await sponsor.ensureGas(chain.provider, chain.dest, {})).toBe(false);
    expect(chain.broadcasts).toHaveLength(0);
  });

  it('recusa endereco que nao bate com a chave', () => {
    expect(() => GasSponsor.fromPrivateKey(KEY, 5n, 1n, `0x${'ab'.repeat(20)}`)).toThrow(
      /nao corresponde/,
    );
  });
});
