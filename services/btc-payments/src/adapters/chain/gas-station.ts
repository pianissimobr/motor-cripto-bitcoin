import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

/**
 * Tesouraria de gas do motor ("gas station").
 *
 * O gas de uma saida on-chain (pagar um Pix com cripto) sai da carteira de
 * quem paga. Como o usuario normalmente so tem a stablecoin, o motor empresta
 * o nativo: a conta da tesouraria envia um pouco de POL para a carteira do
 * usuario antes do envio.
 *
 * A chave fica isolada em `GAS_STATION_PRIVATE_KEY` e nao e usada para mais
 * nada: e so para o POL do gas. O custo (centavos por operacao) e absorvido
 * pelo motor ou reembolsado no extrato do usuario.
 */

export type GasStationConfig = {
  enabled: boolean;
  privateKey?: string;
  rpcUrls: string[];
  chainId: number;
  /** Valor maximo por reposicao (em wei do nativo). */
  maxTopUpWei: bigint;
  /** Piso da tesouraria: abaixo disso, o motor nao repõe. */
  minTreasuryWei: bigint;
};

export type GasStationBalance = {
  address: string;
  balanceWei: bigint;
};

export class GasStationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'GasStationError';
    this.code = code;
  }
}

const buildChain = (chainId: number): Chain =>
  chainId === polygon.id
    ? polygon
    : defineChain({
        id: chainId,
        name: 'Polygon',
        nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
        rpcUrls: { default: { http: [] } },
      });

/**
 * Envia nativo (POL) da tesouraria para um endereco.
 *
 * Devolve o hash da transacao. Nao ha retry: quem chama decide (a operacao do
 * usuario nao pode ser duplicada em silencio).
 */
export async function sendNative(options: {
  config: GasStationConfig;
  to: string;
  amountWei: bigint;
  timeoutMs?: number;
}): Promise<{ hash: string; from: string }> {
  if (!options.config.enabled) {
    throw new GasStationError('gas station desabilitada', 'gas_station_off');
  }
  if (!options.config.privateKey) {
    throw new GasStationError(
      'gas station sem chave de tesouraria',
      'gas_station_no_key',
    );
  }
  if (options.amountWei <= 0n) {
    throw new GasStationError(
      'valor de reposicao invalido',
      'gas_station_bad_amount',
    );
  }
  if (options.amountWei > options.config.maxTopUpWei) {
    throw new GasStationError(
      'valor de reposicao acima do teto',
      'gas_station_above_cap',
    );
  }

  const account = privateKeyToAccount(options.config.privateKey as `0x${string}`);
  const chain = buildChain(options.config.chainId);
  const transport = http(options.config.rpcUrls[0] ?? '', {
    timeout: options.timeoutMs ?? 15_000,
  });
  const wallet = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < options.config.minTreasuryWei + options.amountWei) {
    throw new GasStationError(
      'tesouraria de gas abaixo do piso',
      'gas_station_low_treasury',
    );
  }

  const hash = await wallet.sendTransaction({
    to: options.to as `0x${string}`,
    value: options.amountWei,
  });

  return { hash, from: account.address };
}

/** Saldo nativo da tesouraria. */
export async function treasuryBalance(options: {
  config: GasStationConfig;
  timeoutMs?: number;
}): Promise<GasStationBalance> {
  if (!options.config.privateKey) {
    throw new GasStationError(
      'gas station sem chave de tesouraria',
      'gas_station_no_key',
    );
  }
  const account = privateKeyToAccount(options.config.privateKey as `0x${string}`);
  const chain = buildChain(options.config.chainId);
  const transport = http(options.config.rpcUrls[0] ?? '', {
    timeout: options.timeoutMs ?? 15_000,
  });
  const client = createPublicClient({ chain, transport });
  const balanceWei = await client.getBalance({ address: account.address });
  return { address: account.address, balanceWei };
}

/** Saldo nativo de um endereco qualquer (o destino da reposicao). */
export async function nativeBalanceOf(options: {
  config: GasStationConfig;
  address: string;
  timeoutMs?: number;
}): Promise<bigint> {
  const chain = buildChain(options.config.chainId);
  const transport = http(options.config.rpcUrls[0] ?? '', {
    timeout: options.timeoutMs ?? 15_000,
  });
  const client = createPublicClient({ chain, transport });
  return client.getBalance({ address: options.address as `0x${string}` });
}
