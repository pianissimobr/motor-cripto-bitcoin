/**
 * Registro de chains suportadas. O motor e multi-chain por configuracao:
 * cada `ramp_profile` aponta para (chain, asset, contract) e o monitor
 * itera sobre todos os perfis ativos.
 */

export type ChainSpec = {
  id: number;
  name: string;
  nativeSymbol: string;
  rpcEnvKey: string;
  /** Confirmacoes tipicas para liquidacao final. */
  defaultConfirmations: number;
  /** Tempo medio de bloco (ms), usado para estimativas. */
  blockTimeMs: number;
  explorerTxUrl: (hash: string) => string;
  explorerAddressUrl: (address: string) => string;
};

export const CHAINS: Record<string, ChainSpec> = {
  polygon: {
    id: 137,
    name: 'Polygon PoS',
    nativeSymbol: 'POL',
    rpcEnvKey: 'RPC_URL_POLYGON',
    defaultConfirmations: 30,
    blockTimeMs: 2_200,
    explorerTxUrl: (h) => `https://polygonscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://polygonscan.com/address/${a}`,
  },
  amoy: {
    id: 80002,
    name: 'Polygon Amoy (testnet)',
    nativeSymbol: 'POL',
    rpcEnvKey: 'RPC_URL_AMOY',
    defaultConfirmations: 5,
    blockTimeMs: 2_200,
    explorerTxUrl: (h) => `https://amoy.polygonscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://amoy.polygonscan.com/address/${a}`,
  },
  arbitrum: {
    id: 42161,
    name: 'Arbitrum One',
    nativeSymbol: 'ETH',
    rpcEnvKey: 'RPC_URL_ARBITRUM',
    defaultConfirmations: 30,
    blockTimeMs: 250,
    explorerTxUrl: (h) => `https://arbiscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://arbiscan.io/address/${a}`,
  },
  base: {
    id: 8453,
    name: 'Base',
    nativeSymbol: 'ETH',
    rpcEnvKey: 'RPC_URL_BASE',
    defaultConfirmations: 30,
    blockTimeMs: 2_000,
    explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://basescan.org/address/${a}`,
  },
  ethereum: {
    id: 1,
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    rpcEnvKey: 'RPC_URL_ETHEREUM',
    defaultConfirmations: 12,
    blockTimeMs: 12_000,
    explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://etherscan.io/address/${a}`,
  },
};

export function chainSpec(chain: string): ChainSpec {
  const spec = CHAINS[chain.toLowerCase()];
  if (!spec) {
    throw new Error(`chain desconhecida: "${chain}". Suportadas: ${Object.keys(CHAINS).join(', ')}`);
  }
  return spec;
}

export function explorerTxUrl(chain: string, hash: string): string {
  return chainSpec(chain).explorerTxUrl(hash);
}

export function explorerAddressUrl(chain: string, address: string): string {
  return chainSpec(chain).explorerAddressUrl(address);
}
