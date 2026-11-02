import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  fallback,
  getAddress,
  http,
  defineChain,
} from 'viem';

export type UsdcSettlementVerification =
  | { kind: 'ok' }
  | { kind: 'pending'; detail: string }
  | { kind: 'invalid'; detail: string };

/**
 * Confere on-chain que a liquidacao PIX de fato entregou USDC para a tesouraria.
 * - `pending`: ainda nao da para afirmar (tx nao indexada / erro de rede).
 * - `invalid`: prova de que a liquidacao nao corresponde ao esperado (revertida,
 *   sem Transfer USDC para a treasury, ou valor abaixo do esperado).
 */
export async function verifyUsdcSettlement(input: {
  rpcUrls: string[];
  chainId: number;
  usdcAddress: string;
  txHash: string;
  recipient: string;
  minAmountMinor: bigint;
  timeoutMs?: number;
}): Promise<UsdcSettlementVerification> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
    return { kind: 'invalid', detail: 'settlement_tx_hash invalido' };
  }
  if (input.minAmountMinor <= 0n) {
    return { kind: 'invalid', detail: 'valor minimo da liquidacao invalido' };
  }

  let usdcAddress: string;
  let recipient: string;
  try {
    usdcAddress = getAddress(input.usdcAddress).toLowerCase();
    recipient = getAddress(input.recipient).toLowerCase();
  } catch {
    return { kind: 'invalid', detail: 'endereco invalido na verificacao' };
  }

  if (input.rpcUrls.length === 0) {
    return { kind: 'invalid', detail: 'nenhum RPC Base configurado' };
  }

  const transport = fallback(
    input.rpcUrls.map((url) => http(url, { timeout: input.timeoutMs ?? 15_000 })),
  );
  const chain = defineChain({
    id: input.chainId,
    name: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: input.rpcUrls } },
  });
  const client = createPublicClient({ transport, chain });

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({
      hash: input.txHash as `0x${string}`,
    });
  } catch {
    return { kind: 'pending', detail: 'settlement tx ainda nao indexada' };
  }

  if (receipt.status !== 'success') {
    return { kind: 'invalid', detail: 'settlement tx revertida na Base' };
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddress) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'Transfer') continue;
    const args = decoded.args as { to?: string; value?: bigint };
    if (typeof args.to !== 'string' || typeof args.value !== 'bigint') continue;
    if (args.to.toLowerCase() === recipient && args.value >= input.minAmountMinor) {
      return { kind: 'ok' };
    }
  }

  return {
    kind: 'invalid',
    detail: 'settlement tx sem transferencia USDC correspondente para a treasury',
  };
}