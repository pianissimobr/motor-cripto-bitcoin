import { describe, expect, it } from 'vitest';
import {
  parseQuote,
  parseStatus,
  ThorchainClient,
  thorToUsdcMinor,
} from '../src/adapters/conversion/thorchain.js';
import { UpstreamError } from '../src/domain/errors.js';

const USDC = '0x833589fCD6EDB6E08F4C7C32D4f71b54BDA02913';
const TXID = 'a'.repeat(64);

function quoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    inbound_address: 'bc1qinbound',
    memo: 'SWAP:BASE.USDC:0xabc:100/0/0',
    expected_amount_out: '123456789',
    expiry: 1_800_000_000,
    fees: { total: '1000' },
    ...overrides,
  };
}

describe('thorchain', () => {
  it('converte 1e8 THOR para 6 casas de USDC', () => {
    expect(thorToUsdcMinor(100_000_000n)).toBe(1_000_000n);
    expect(thorToUsdcMinor(123_456_789n)).toBe(1_234_567n);
  });

  it('faz quote em multiplos endpoints e escolhe um valido', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(quoteResponse()), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ThorchainClient({
      urls: ['https://a', 'https://b'],
      usdcAddress: USDC,
      fetchImpl,
    });

    const quote = await client.quote({
      sourceAmountSats: 100_000n,
      targetAddress: '0x1111111111111111111111111111111111111111',
      refundAddress: 'bc1qrefund',
    });

    expect(calls).toHaveLength(2);
    expect(quote.expectedAmountOutMinor).toBe(1_234_567n);
    expect(quote.inboundAddress).toBe('bc1qinbound');
    expect(quote.providerOrderId).toHaveLength(32);
  });

  it('aborta quando endpoints divergem no inbound address', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return new Response(
        JSON.stringify(
          quoteResponse({
            inbound_address: call === 1 ? 'bc1qa' : 'bc1qb',
          }),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new ThorchainClient({
      urls: ['https://a', 'https://b'],
      usdcAddress: USDC,
      fetchImpl,
    });

    await expect(
      client.quote({
        sourceAmountSats: 100_000n,
        targetAddress: '0x1111111111111111111111111111111111111111',
        refundAddress: 'bc1qrefund',
      }),
    ).rejects.toThrow(UpstreamError);
  });

  it('rejeita quote sem memo e status concluido', () => {
    expect(() =>
      parseQuote(
        { inbound_address: 'bc1q', expected_amount_out: '1', expiry: 1 },
        'https://a',
        1n,
      ),
    ).toThrow(/memo/);

    const status = parseStatus({
      observed_tx: { tx: { status: 'done' } },
      outbound_observed: {
        tx: {
          id: TXID,
          chain: 'BASE',
          status: 'done',
          coins: [{ amount: '50000000' }],
        },
      },
    });
    expect(status.done).toBe(true);
    expect(status.outboundTxid).toBe(TXID);
    expect(status.outboundAmountMinor).toBe(500_000n);
  });
});
