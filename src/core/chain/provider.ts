import { JsonRpcProvider, type Provider } from 'ethers';
import { chainSpec } from './chains.js';

/**
 * Fabrica de providers. `staticNetwork` evita a chamada extra de eth_chainId
 * e o batch desativado evita reordenacao de requisicoes no RPC.
 */
export function createProvider(chain: string, rpcUrl: string): JsonRpcProvider {
  const spec = chainSpec(chain);
  return new JsonRpcProvider(rpcUrl, spec.id, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

export type ProviderFactory = (chain: string) => Provider;

/**
 * Le o chainId do provider. O tipo `Provider` do ethers nao expoe `network`
 * (apenas `AbstractProvider` expoe), entao o acesso e feito com um cast
 * defensivo e erro explicito quando ausente.
 */
export function providerChainId(provider: Provider): number {
  const network = (provider as unknown as { network?: { chainId?: bigint } }).network;
  if (network?.chainId === undefined) {
    throw new Error('provider nao expoe chainId (use JsonRpcProvider com staticNetwork)');
  }
  return Number(network.chainId);
}

export function createProviderFactory(rpcUrls: Record<string, string>): ProviderFactory {
  return (chain: string) => {
    const url = rpcUrls[chain.toLowerCase()];
    if (!url) throw new Error(`RPC nao configurado para a chain "${chain}"`);
    return createProvider(chain, url);
  };
}
