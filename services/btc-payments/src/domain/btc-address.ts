import { base58check, bech32, bech32m } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Endereco Bitcoin valido.
 *
 * A SwapKit exige um endereco de origem na rota e o tela contra a lista de
 * sanctions: um endereco invalido derruba a cotacao. A conferencia aqui e
 * pelo checksum (bech32/bech32m para segwit e taproot, base58check para o
 * legado), nao por regex.
 */
export function isBitcoinAddress(value: string): boolean {
  const address = value.trim();
  if (address.length === 0) return false;

  const lower = address.toLowerCase();
  if (lower.startsWith('bc1') || lower.startsWith('tb1') || lower.startsWith('bcrt1')) {
    // Taproot usa bech32m; os outros usam bech32.
    for (const codec of [bech32, bech32m]) {
      try {
        const decoded = codec.decode(address as `${string}1${string}`, 90);
        if (decoded.prefix === 'bc' || decoded.prefix === 'tb' || decoded.prefix === 'bcrt') {
          return true;
        }
      } catch {
        // tenta o outro codec
      }
    }
    return false;
  }

  try {
    base58check(sha256).decode(address);
    return true;
  } catch {
    return false;
  }
}

/** `true` quando o endereco e de uma rede que a SwapKit aceita. */
export function isMainnetBitcoinAddress(value: string): boolean {
  const address = value.trim().toLowerCase();
  if (address.startsWith('bc1')) return true;
  if (address.startsWith('tb1') || address.startsWith('bcrt1')) return false;
  return /^[13mn2]/.test(address);
}
