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
 *
 * `usdcAddresses` aceita mais de um contrato: a Lunium pode entregar o token
 * nativo ou o bridged da rede, e a API nao diz qual. A verificacao considera
 * qualquer um da lista — com um endereco so, uma entrega valida cairia em
 * `invalid` e a cobranca ficaria presa em `manual`.
 */
export async function verifyUsdcSettlement(input: {
  rpcUrls: string[];
  chainId: number;
  usdcAddresses: string[];
  txHash: string;
  recipient: string;
  minAmountMinor: bigint;
  timeoutMs?: number;
  /** Nome da rede, so para o log. */
  chainLabel?: string;
}): Promise<UsdcSettlementVerification> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
    return { kind: 'invalid', detail: 'settlement_tx_hash invalido' };
  }
  if (input.minAmountMinor <= 0n) {
    return { kind: 'invalid', detail: 'valor minimo da liquidacao invalido' };
  }
  if (input.usdcAddresses.length === 0) {
    return { kind: 'invalid', detail: 'nenhum contrato de USDC configurado' };
  }

  let usdcAddresses: string[];
  let recipient: string;
  try {
    usdcAddresses = input.usdcAddresses.map((address) =>
      getAddress(address).toLowerCase(),
    );
    recipient = getAddress(input.recipient).toLowerCase();
  } catch {
    return { kind: 'invalid', detail: 'endereco invalido na verificacao' };
  }

  if (input.rpcUrls.length === 0) {
    return { kind: 'invalid', detail: 'nenhum RPC configurado' };
  }

  const transport = fallback(
    input.rpcUrls.map((url) => http(url, { timeout: input.timeoutMs ?? 15_000 })),
  );
  const chain = defineChain({
    id: input.chainId,
    name: input.chainLabel ?? 'EVM',
    nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
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
    return {
      kind: 'invalid',
      detail: `settlement tx revertida em ${input.chainLabel ?? 'EVM'}`,
    };
  }

  for (const log of receipt.logs) {
    if (!usdcAddresses.includes(log.address.toLowerCase())) continue;
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
    detail:
      'settlement tx sem transferencia USDC correspondente para a treasury ' +
      `(contratos conferidos: ${usdcAddresses.join(', ')})`,
  };
}
