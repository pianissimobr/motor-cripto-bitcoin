import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from 'viem';
import { verifyUsdcSettlement } from '../src/adapters/chain/usdc-settlement-verify.js';
import { verifySwapDelivery } from '../src/adapters/chain/swap-delivery-verify.js';

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const RECIPIENT = '0x4Cd01696Cd0165D6020AB7d8AE866Fdf2feD3855';
const FROM = '0x1111111111111111111111111111111111111111';
const TX = `0x${'ab'.repeat(32)}`;

function transferLog(value: bigint) {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { from: FROM, to: RECIPIENT },
  }) as string[];
  return {
    address: USDC,
    topics,
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex: 3,
    transactionHash: TX,
  };
}

function chainAt(tip: bigint, txBlock: bigint) {
  return {
    getBlockNumber: async () => tip,
    getTransactionReceipt: async () => ({
      status: 'success' as const,
      blockNumber: txBlock,
      logs: [transferLog(1_000_000n)],
    }),
    getTransferLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      txBlock >= fromBlock && txBlock <= toBlock
        ? [{ transactionHash: TX, logIndex: 3, value: 1_000_000n, blockNumber: txBlock }]
        : [],
  };
}

const settlement = (chain: ReturnType<typeof chainAt>, minConfirmations?: number) =>
  verifyUsdcSettlement({
    rpcUrls: [],
    chainId: 137,
    usdcAddresses: [USDC],
    txHash: TX,
    recipient: RECIPIENT,
    minAmountMinor: 1_000_000n,
    chain,
    ...(minConfirmations !== undefined ? { minConfirmations } : {}),
  });

describe('liquidacao Pix: confirmacoes on-chain', () => {
  it('fica pendente enquanto o bloco e raso', async () => {
    const result = await settlement(chainAt(105n, 100n), 12);
    expect(result).toEqual({ kind: 'pending', detail: 'aguardando confirmacoes (6/12)' });
  });

  it('aceita com a profundidade minima', async () => {
    expect(await settlement(chainAt(111n, 100n), 12)).toEqual({ kind: 'ok' });
  });

  it('sem minConfirmations basta estar num bloco', async () => {
    expect(await settlement(chainAt(100n, 100n))).toEqual({ kind: 'ok' });
  });

  it('falha ao ler o topo da rede nao liquida', async () => {
    const chain = chainAt(0n, 100n);
    chain.getBlockNumber = async () => {
      throw new Error('rpc fora');
    };
    expect((await settlement(chain, 12)).kind).toBe('pending');
  });
});

describe('entrega de swap: confirmacoes on-chain', () => {
  const base = { usdcAddresses: [USDC], recipient: RECIPIENT, minMinor: 1_000_000n, isClaimed: async () => false };

  it('com hash: pendente ate a profundidade minima', async () => {
    const shallow = await verifySwapDelivery({ ...base, chain: chainAt(105n, 100n), txHash: TX, minConfirmations: 12 });
    expect(shallow.kind).toBe('pending');
    const deep = await verifySwapDelivery({ ...base, chain: chainAt(111n, 100n), txHash: TX, minConfirmations: 12 });
    expect(deep.kind).toBe('ok');
  });

  it('sem hash: a busca ignora blocos rasos', async () => {
    const shallow = await verifySwapDelivery({ ...base, chain: chainAt(105n, 100n), fromBlock: 90n, minConfirmations: 12 });
    expect(shallow).toEqual({ kind: 'pending', detail: 'entrega ainda nao vista na rede' });
    const deep = await verifySwapDelivery({ ...base, chain: chainAt(111n, 100n), fromBlock: 90n, minConfirmations: 12 });
    expect(deep.kind).toBe('ok');
  });
});
