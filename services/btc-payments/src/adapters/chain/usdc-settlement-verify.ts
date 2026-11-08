import { decodeEventLog, erc20Abi, getAddress } from 'viem';
import {
  createSwapDeliveryChain,
  notDeepEnough,
  type SwapDeliveryChain,
} from './swap-delivery-verify.js';

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
  /**
   * Profundidade minima do bloco da liquidacao. Com 1, uma reorganizacao
   * rasa depois do `liquidado` deixava a cobranca paga sem o USDC.
   */
  minConfirmations?: number;
  /** Acesso a rede (injetavel nos testes); por padrao, os `rpcUrls`. */
  chain?: Pick<SwapDeliveryChain, 'getBlockNumber' | 'getTransactionReceipt'>;
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

  if (!input.chain && input.rpcUrls.length === 0) {
    return { kind: 'invalid', detail: 'nenhum RPC configurado' };
  }
  const chain =
    input.chain ??
    createSwapDeliveryChain({
      rpcUrls: input.rpcUrls,
      chainId: input.chainId,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.chainLabel !== undefined ? { chainLabel: input.chainLabel } : {}),
    });

  let receipt;
  try {
    receipt = await chain.getTransactionReceipt(input.txHash);
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
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== 'Transfer') continue;
    const args = decoded.args as { to?: string; value?: bigint };
    if (typeof args.to !== 'string' || typeof args.value !== 'bigint') continue;
    if (args.to.toLowerCase() === recipient && args.value >= input.minAmountMinor) {
      const shallow = await notDeepEnough(
        chain,
        receipt.blockNumber,
        BigInt(Math.max(1, input.minConfirmations ?? 1)),
      );
      return shallow ?? { kind: 'ok' };
    }
  }

  return {
    kind: 'invalid',
    detail:
      'settlement tx sem transferencia USDC correspondente para a treasury ' +
      `(contratos conferidos: ${usdcAddresses.join(', ')})`,
  };
}
