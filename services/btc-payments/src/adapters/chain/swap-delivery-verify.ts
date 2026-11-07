import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  fallback,
  getAddress,
  http,
  defineChain,
} from 'viem';

export type SwapDeliveryVerification =
  | { kind: 'ok'; detail?: string }
  | { kind: 'pending'; detail: string }
  | { kind: 'invalid'; detail: string };

/**
 * Confere on-chain que o USDC do swap chegou na carteira do cliente.
 *
 * A SwapKit saying "completed" nao e prova: o motor so marca `liquidado`
 * quando ve a transferencia. Duas formas de prova:
 *
 * - **com hash da transacao**: o `Transfer` do ERC-20 para o destino, com
 *   valor maior ou igual ao esperado. E o caminho forte.
 * - **sem hash**: o saldo do destino grew em relacao a linha de base
 *   registrada quando o pedido foi criado. Serve quando o provedor nao
 *   devolve o hash (o trilho de deposito costuma nao devolver).
 *
 * Sem hash e sem linha de base nao ha prova: o resultado e `invalid`, nao
 * `ok`.
 */
export async function verifySwapDelivery(input: {
  rpcUrls: string[];
  chainId: number;
  /** Contratos aceitos como USDC (o nativo e o bridged da rede). */
  usdcAddresses: string[];
  recipient: string;
  /** Quanto deve ter chegado, em unidades minimas do token. */
  expectedMinor: bigint;
  /** Hash da transacao de entrega, quando o provedor devolve. */
  txHash?: string | null;
  /** Saldo do destino antes do pedido (linha de base). */
  baselineMinor?: bigint | null;
  timeoutMs?: number;
  chainLabel?: string;
}): Promise<SwapDeliveryVerification> {
  if (input.expectedMinor <= 0n) {
    return { kind: 'invalid', detail: 'valor minimo da entrega invalido' };
  }
  if (input.usdcAddresses.length === 0) {
    return { kind: 'invalid', detail: 'nenhum contrato de USDC configurado' };
  }
  if (input.rpcUrls.length === 0) {
    return { kind: 'invalid', detail: 'nenhum RPC configurado' };
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

  if (input.txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
      return { kind: 'invalid', detail: 'hash da entrega invalido' };
    }
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({
        hash: input.txHash as `0x${string}`,
      });
    } catch {
      return { kind: 'pending', detail: 'transacao da entrega ainda nao indexada' };
    }
    if (receipt.status !== 'success') {
      return { kind: 'invalid', detail: 'transacao da entrega revertida' };
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
      if (args.to.toLowerCase() === recipient && args.value >= input.expectedMinor) {
        return { kind: 'ok', detail: 'transferencia de USDC confirmada' };
      }
    }
    return {
      kind: 'invalid',
      detail:
        'transacao da entrega sem transferencia de USDC para o destino ' +
        `(contratos conferidos: ${usdcAddresses.join(', ')})`,
    };
  }

  if (input.baselineMinor === null || input.baselineMinor === undefined) {
    return {
      kind: 'invalid',
      detail: 'sem hash e sem linha de base nao ha como provar a entrega',
    };
  }

  let balance = 0n;
  for (const address of usdcAddresses) {
    try {
      const value = await client.readContract({
        address: address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [recipient as `0x${string}`],
      });
      balance += value as bigint;
    } catch {
      // Um contrato pode falhar (RPC, endereco). Os outros ainda valem.
    }
  }

  if (balance - input.baselineMinor >= input.expectedMinor) {
    return { kind: 'ok', detail: 'saldo do destino cresceu o valor esperado' };
  }
  return {
    kind: 'pending',
    detail: `saldo do destino ainda ${balance - input.baselineMinor} de ${input.expectedMinor}`,
  };
}
