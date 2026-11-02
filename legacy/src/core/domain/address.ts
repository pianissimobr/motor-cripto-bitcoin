import { getAddress } from 'ethers';

/**
 * Endereco EVM canonico.
 *
 * Armazenamento e comparacao usam SEMPRE lowercase: a chain EVM trata
 * enderecos como case-insensitive, e guardar checksum misto fazia o filtro
 * `where address = lower(param)` nunca encontrar o link.
 *
 * A representacao checksumada (EIP-55) e usada apenas na apresentacao.
 */
export function normalizeAddress(address: string): string {
  return getAddress(address.trim()).toLowerCase();
}

/** Representacao EIP-55 para exibicao/QR. Lanca se o endereco for invalido. */
export function checksumAddress(address: string): string {
  return getAddress(address.trim());
}

export function isAddress(value: string): boolean {
  try {
    getAddress(value.trim());
    return true;
  } catch {
    return false;
  }
}
