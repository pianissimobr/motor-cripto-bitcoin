import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  erc20Abi,
  fallback,
  getAddress,
  http,
  parseAbiItem,
} from 'viem';

/** A transferencia que provou a entrega: um log de `Transfer` do USDC. */
export type SwapDeliveryProof = {
  txHash: string;
  logIndex: number;
  valueMinor: bigint;
};

export type SwapDeliveryVerification =
  | { kind: 'ok'; detail?: string; proof: SwapDeliveryProof }
  | { kind: 'pending'; detail: string }
  | { kind: 'invalid'; detail: string };

/** O minimo da rede que a verificacao usa (injetavel nos testes). */
export type SwapDeliveryChain = {
  getBlockNumber: () => Promise<bigint>;
  getTransactionReceipt: (hash: string) => Promise<{
    status: 'success' | 'reverted';
    blockNumber: bigint;
    logs: { address: string; data: string; topics: string[]; logIndex: number | null; transactionHash: string | null }[];
  }>;
  /** Logs de `Transfer(_, to = recipient)` dos contratos, no intervalo. */
  getTransferLogs: (input: {
    contracts: string[];
    recipient: string;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<{ transactionHash: string; logIndex: number; value: bigint; blockNumber: bigint }[]>;
};

/** Janela de cada `eth_getLogs` (RPC publico limita o intervalo). */
const LOG_CHUNK = 1_000n;
/** Busca no maximo isto depois do bloco inicial (~2 dias na Polygon). */
const MAX_SCAN_BLOCKS = 100_000n;

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export function createSwapDeliveryChain(input: {
  rpcUrls: string[];
  chainId: number;
  timeoutMs?: number;
  chainLabel?: string;
}): SwapDeliveryChain {
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
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getTransactionReceipt: async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          data: log.data,
          topics: [...log.topics],
          logIndex: log.logIndex,
          transactionHash: log.transactionHash,
        })),
      };
    },
    getTransferLogs: async ({ contracts, recipient, fromBlock, toBlock }) => {
      const logs = await client.getLogs({
        address: contracts as `0x${string}`[],
        event: TRANSFER_EVENT,
        args: { to: recipient as `0x${string}` },
        fromBlock,
        toBlock,
      });
      return logs
        .filter((log) => log.transactionHash && log.logIndex !== null && log.blockNumber !== null)
        .map((log) => ({
          transactionHash: log.transactionHash!,
          logIndex: log.logIndex!,
          value: log.args.value ?? 0n,
          blockNumber: log.blockNumber!,
        }));
    },
  };
}

/**
 * Confere on-chain que o USDC do swap chegou na carteira do cliente.
 *
 * A SwapKit dizer "completed" nao e prova: o motor so marca `liquidado`
 * quando ve a transferencia. Duas formas de prova, e as duas apontam **uma**
 * transferencia (tx + indice do log), que o servico reserva para o pedido:
 *
 * - **com hash**: um `Transfer` do USDC para o destino dentro da transacao;
 * - **sem hash** (o trilho de deposito costuma nao devolver): um `Transfer`
 *   para o destino a partir do bloco em que o pedido nasceu.
 *
 * Uma transferencia ja usada por outro pedido nao conta (`isClaimed`): sem
 * isso, dois pedidos para o mesmo destino seriam provados pela mesma entrega.
 * Comparar saldo nao serve: qualquer outra entrada no endereco (um Pix, outro
 * swap) contaria.
 */
export async function verifySwapDelivery(input: {
  chain: SwapDeliveryChain;
  /** Contratos aceitos como USDC (o nativo e o bridged da rede). */
  usdcAddresses: string[];
  recipient: string;
  /** Minimo aceito, em unidades minimas (o cotado menos o slippage). */
  minMinor: bigint;
  /** Hash da transacao de entrega, quando o provedor devolve. */
  txHash?: string | null;
  /** Bloco em que o pedido nasceu (gravado pelo motor). */
  fromBlock?: bigint | null;
  isClaimed: (txHash: string, logIndex: number) => Promise<boolean>;
  /**
   * Profundidade minima do bloco da entrega (1 = basta estar num bloco).
   * Uma reorganizacao rasa pode tirar a transferencia da cadeia depois que o
   * motor ja marcou `liquidado`; esperar alguns blocos fecha essa janela.
   */
  minConfirmations?: number;
}): Promise<SwapDeliveryVerification> {
  const depth = BigInt(Math.max(1, input.minConfirmations ?? 1));
  if (input.minMinor <= 0n) {
    return { kind: 'invalid', detail: 'valor minimo da entrega invalido' };
  }
  if (input.usdcAddresses.length === 0) {
    return { kind: 'invalid', detail: 'nenhum contrato de USDC configurado' };
  }

  let usdcAddresses: string[];
  let recipient: string;
  try {
    usdcAddresses = input.usdcAddresses.map((address) => getAddress(address).toLowerCase());
    recipient = getAddress(input.recipient).toLowerCase();
  } catch {
    return { kind: 'invalid', detail: 'endereco invalido na verificacao' };
  }

  if (input.txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
      return { kind: 'invalid', detail: 'hash da entrega invalido' };
    }
    let receipt;
    try {
      receipt = await input.chain.getTransactionReceipt(input.txHash);
    } catch {
      return { kind: 'pending', detail: 'transacao da entrega ainda nao indexada' };
    }
    if (receipt.status !== 'success') {
      return { kind: 'invalid', detail: 'transacao da entrega revertida' };
    }
    let alreadyUsed = false;
    for (const log of receipt.logs) {
      if (!usdcAddresses.includes(log.address.toLowerCase())) continue;
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: erc20Abi,
          data: log.data as `0x${string}`,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
      } catch {
        continue;
      }
      if (decoded.eventName !== 'Transfer') continue;
      const args = decoded.args as { to?: string; value?: bigint };
      if (typeof args.to !== 'string' || typeof args.value !== 'bigint') continue;
      if (args.to.toLowerCase() !== recipient || args.value < input.minMinor) continue;
      if (log.logIndex === null) continue;
      if (await input.isClaimed(input.txHash, log.logIndex)) {
        alreadyUsed = true;
        continue;
      }
      const shallow = await notDeepEnough(input.chain, receipt.blockNumber, depth);
      if (shallow) return shallow;
      return {
        kind: 'ok',
        detail: 'transferencia de USDC confirmada',
        proof: { txHash: input.txHash.toLowerCase(), logIndex: log.logIndex, valueMinor: args.value },
      };
    }
    return {
      kind: 'invalid',
      detail: alreadyUsed
        ? 'a transferencia da entrega ja provou outro pedido'
        : 'transacao da entrega sem transferencia de USDC para o destino ' +
          `(contratos conferidos: ${usdcAddresses.join(', ')})`,
    };
  }

  if (input.fromBlock === null || input.fromBlock === undefined) {
    return {
      kind: 'invalid',
      detail: 'sem hash e sem bloco inicial nao ha como provar a entrega',
    };
  }

  let latest: bigint;
  try {
    latest = await input.chain.getBlockNumber();
  } catch {
    return { kind: 'pending', detail: 'rede indisponivel para conferir a entrega' };
  }
  const limit = input.fromBlock + MAX_SCAN_BLOCKS;
  // So olha blocos com a profundidade minima: o que e mais novo ainda pode
  // sair da cadeia e volta a ser visto numa proxima rodada.
  const deep = latest - (depth - 1n);
  const end = deep < limit ? deep : limit;
  for (let from = input.fromBlock; from <= end; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n < end ? from + LOG_CHUNK - 1n : end;
    let logs;
    try {
      logs = await input.chain.getTransferLogs({ contracts: usdcAddresses, recipient, fromBlock: from, toBlock: to });
    } catch {
      return { kind: 'pending', detail: 'rede indisponivel para conferir a entrega' };
    }
    const sorted = [...logs].sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
    for (const log of sorted) {
      if (log.value < input.minMinor) continue;
      if (await input.isClaimed(log.transactionHash, log.logIndex)) continue;
      return {
        kind: 'ok',
        detail: 'transferencia de USDC para o destino depois do pedido',
        proof: { txHash: log.transactionHash.toLowerCase(), logIndex: log.logIndex, valueMinor: log.value },
      };
    }
  }
  if (deep > limit) {
    return { kind: 'invalid', detail: 'nenhuma entrega na janela de busca depois do pedido' };
  }
  return { kind: 'pending', detail: 'entrega ainda nao vista na rede' };
}

/**
 * `pending` quando o bloco ainda nao tem `depth` confirmacoes; `null` quando
 * ja tem. Falha de rede tambem e `pending`: na duvida, nao liquida.
 */
export async function notDeepEnough(
  chain: Pick<SwapDeliveryChain, 'getBlockNumber'>,
  blockNumber: bigint,
  depth: bigint,
): Promise<{ kind: 'pending'; detail: string } | null> {
  if (depth <= 1n) return null;
  let latest: bigint;
  try {
    latest = await chain.getBlockNumber();
  } catch {
    return { kind: 'pending', detail: 'rede indisponivel para contar confirmacoes' };
  }
  const confirmations = latest - blockNumber + 1n;
  if (confirmations >= depth) return null;
  return {
    kind: 'pending',
    detail: `aguardando confirmacoes (${confirmations < 0n ? 0n : confirmations}/${depth})`,
  };
}
