import { Interface, type InterfaceAbi } from 'ethers';

/**
 * ABI minima de ERC-20 (transfer/balanceOf/decimals/symbol) + evento Transfer.
 * Mantida minima de proposito: menos superficie, menos risco.
 */
export const ERC20_ABI: InterfaceAbi = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export const erc20Interface = new Interface(ERC20_ABI);

export const TRANSFER_TOPIC = erc20Interface.getEvent('Transfer')!.topicHash;

/**
 * Converte um endereco EVM em topic de 32 bytes (left-padded).
 *
 * Os nodes JSON-RPC exigem que um endereco usado como topic tenga
 * exatamente 32 bytes; sem o padding o RPC responde
 * "hex has invalid length 20 after decoding; expected 32 for topic".
 */
export function addressToTopic(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '');
  if (clean.length !== 40) {
    throw new Error(`endereco invalido para topic: ${address}`);
  }
  return `0x${clean.padStart(64, '0')}`;
}

export function encodeTransfer(to: string, amount: bigint): string {
  return erc20Interface.encodeFunctionData('transfer', [to, amount]);
}

export type DecodedTransfer = {
  from: string;
  to: string;
  value: bigint;
};

export function decodeTransferLog(log: { topics: readonly string[]; data: string }): DecodedTransfer | null {
  if (log.topics.length < 3) return null;
  try {
    const parsed = erc20Interface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) return null;
    return {
      from: String(parsed.args[0]),
      to: String(parsed.args[1]),
      value: BigInt(parsed.args[2]),
    };
  } catch {
    return null;
  }
}
