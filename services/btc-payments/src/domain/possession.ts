import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { ValidationError } from './errors.js';
import type { PossessionPurpose } from './types.js';

export const POSSESSION_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export const POSSESSION_PURPOSES: readonly PossessionPurpose[] = [
  'client_registration',
  'wallet_registration',
];

export function isPossessionPurpose(value: string): value is PossessionPurpose {
  return (POSSESSION_PURPOSES as readonly string[]).includes(value);
}

/**
 * Mensagem que o app assina para provar que o endereco e dele.
 *
 * O texto e canonico: o motor guarda a mensagem no desafio e reconfere a
 * assinatura sobre exatamente ela.
 */
export function buildPossessionMessage(input: {
  purpose: PossessionPurpose;
  address: string;
  nonce: string;
}): string {
  return [
    'btc-payments: prova de posse',
    `endereço: ${input.address}`,
    `nonce: ${input.nonce}`,
  ].join('\n');
}

export function generatePossessionNonce(): string {
  return randomBytes(16).toString('hex');
}

/** Endereco EVM em EIP-55 (checksum). Recusa o que nao for endereco. */
export function normalizePossessionAddress(value: string): string {
  const trimmed = value.trim();
  if (!isAddress(trimmed)) {
    throw new ValidationError('endereco invalido');
  }
  return getAddress(trimmed);
}

/**
 * Confere a assinatura EIP-191 (`personal_sign`) do desafio.
 *
 * A verificacao e local (recuperacao ECDSA): nao gasta cota da LuniumPay nem
 * depende de RPC. Carteiras de contrato (ERC-1271) nao sao suportadas aqui —
 * o app assina com a chave da carteira EVM local.
 */
export async function verifyPossessionSignature(input: {
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  if (!isAddress(input.address)) return false;
  if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature)) return false;
  try {
    return await verifyMessage({
      address: input.address as Address,
      message: input.message,
      signature: input.signature as Hex,
    });
  } catch {
    return false;
  }
}
