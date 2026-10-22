import {
  HDNodeWallet,
  Mnemonic,
  Transaction,
  Wallet,
  keccak256,
  type TransactionRequest,
} from 'ethers';

import { Sweeper } from '../src/core/chain/sweeper.js';
import { createMotor } from '../src/core/index.js';
import { HdWallet } from '../src/core/hd/hd-wallet.js';
import { silentLogger } from '../src/core/logger.js';
import type { Signer } from '../src/core/signer/signer.js';
import { createFakeRepositories } from './fakes.js';

export const MNEMONIC = 'test test test test test test test test test test test junk';
export const accountNode = HDNodeWallet.fromMnemonic(
  Mnemonic.fromPhrase(MNEMONIC),
  "m/44'/60'/0'",
);
export const XPUB = accountNode.neuter().extendedKey;
export const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export const CARTEIRA = '0x1111111111111111111111111111111111111111';

export type FakeChainOptions = {
  tokenBalance?: bigint;
  nativeBalance?: bigint;
  noncePending?: number;
  nonceLatest?: number;
  gasEstimate?: bigint;
  feePerGas?: bigint;
  receiptStatus?: number | null;
  dustReceiptStatus?: number | null;
  dustNativeAfter?: bigint;
  failBroadcast?: string;
};

export type FakeReceipt = {
  status: number | null;
  blockNumber: number;
  gasUsed: bigint;
};

/** Provider fake com nonce/saldo/recibos mutaveis, suficiente para o sweeper. */
export function createFakeChain(opts: FakeChainOptions = {}) {
  const feePerGas = opts.feePerGas ?? 1_000_000_000n;
  const estado = {
    tokenBalance: opts.tokenBalance ?? 0n,
    nativeBalance: opts.nativeBalance ?? 10n ** 18n,
    noncePending: opts.noncePending ?? opts.nonceLatest ?? 0,
    nonceLatest: opts.nonceLatest ?? 0,
    broadcasts: [] as string[],
    receipts: new Map<string, FakeReceipt>(),
  };

  const provider = {
    network: { chainId: 137n },
    estado,
    getBalance: async () => estado.nativeBalance,
    getBlockNumber: async () => 1000,
    getFeeData: async () => ({
      maxFeePerGas: feePerGas,
      maxPriorityFeePerGas: feePerGas,
      gasPrice: feePerGas,
    }),
    getTransactionCount: async (_addr: string, tag?: string) =>
      tag === 'pending' ? estado.noncePending : estado.nonceLatest,
    estimateGas: async () => opts.gasEstimate ?? 60_000n,
    getCode: async () => '0x60',
    getBlock: async () => null,
    getLogs: async () => [],
    getTransactionReceipt: async (hash: string) => estado.receipts.get(hash) ?? null,
    call: async (req: { to: string; data: string }) => {
      if (req.data?.startsWith('0x70a08231')) {
        return '0x' + estado.tokenBalance.toString(16).padStart(64, '0');
      }
      return '0x';
    },
    broadcastTransaction: async (raw: string) => {
      if (opts.failBroadcast) throw new Error(opts.failBroadcast);

      const parsed = Transaction.from(raw);
      const hash = keccak256(raw);
      const gasCost =
        parsed.gasLimit * (parsed.maxFeePerGas ?? parsed.gasPrice ?? feePerGas);
      const isToken = parsed.to?.toLowerCase() === USDC.toLowerCase();
      const status = isToken
        ? (opts.receiptStatus ?? 1)
        : (opts.dustReceiptStatus ?? 1);
      const blockNumber = 1000 + estado.broadcasts.length;
      const receipt: FakeReceipt = {
        status,
        blockNumber,
        gasUsed: isToken ? 50_000n : 21_000n,
      };

      if (isToken) {
        estado.tokenBalance = 0n;
        estado.nativeBalance =
          estado.nativeBalance > gasCost ? estado.nativeBalance - gasCost : 0n;
      } else if (opts.dustNativeAfter !== undefined) {
        estado.nativeBalance = opts.dustNativeAfter;
      } else {
        const gasto = parsed.value + gasCost;
        estado.nativeBalance =
          estado.nativeBalance > gasto ? estado.nativeBalance - gasto : 0n;
      }

      estado.nonceLatest = Math.max(estado.nonceLatest, parsed.nonce + 1);
      estado.noncePending = Math.max(estado.noncePending, parsed.nonce + 1);
      estado.broadcasts.push(raw);
      estado.receipts.set(hash, receipt);

      return {
        hash,
        wait: async () => receipt,
      };
    },
  };

  return { provider, estado };
}

export function createTestSigner(): Signer {
  const walletFor = (index: number): Wallet => {
    // Mesmo caminho do HdWallet: conta / prefixo 0 / indice.
    const child = accountNode.derivePath(`0/${index}`);
    if (!child.privateKey) throw new Error('sem chave privada no harness');
    return new Wallet(child.privateKey);
  };

  return {
    mode: 'local',
    addressFor: (index: number) => HdWallet.fromAccountXpub(XPUB, '0', 0).deriveAddress(index),
    signTransfer: async (input) => {
      const tx: TransactionRequest = {
        to: input.to,
        data: input.data,
        value: input.value,
        chainId: input.chainId,
        nonce: input.nonce,
        gasLimit: input.gasLimit,
      };
      if (input.maxPriorityFeePerGas !== undefined) {
        tx.type = 2;
        tx.maxFeePerGas = input.maxFeePerGas;
        tx.maxPriorityFeePerGas = input.maxPriorityFeePerGas;
      } else if (input.maxFeePerGas !== undefined) {
        tx.type = 0;
        tx.gasPrice = input.maxFeePerGas;
      }
      const rawTransaction = await walletFor(input.index).signTransaction(tx);
      return { rawTransaction, hash: keccak256(rawTransaction) };
    },
    buildUnsigned: (input) => ({
      from: HdWallet.fromAccountXpub(XPUB, '0', 0).deriveAddress(input.index),
      to: input.to,
      data: input.data,
      value: input.value.toString(),
      chainId: input.chainId,
      nonce: input.nonce,
      gasLimit: input.gasLimit.toString(),
      maxFeePerGas: input.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: input.maxPriorityFeePerGas?.toString(),
    }),
    describe: () => 'test signer',
  };
}

export function setupSweepContext() {
  const repos = createFakeRepositories();
  const motor = createMotor({
    repos,
    hdWallet: HdWallet.fromAccountXpub(XPUB, '0', 0),
    signer: createTestSigner(),
    providerFactory: () => {
      throw new Error('provider nao usado no setup');
    },
    gasSponsor: {
      enabled: false,
      address: null,
      balance: async () => 0n,
      ensureGas: async () => false,
    } as never,
    logger: silentLogger,
    dataKey: Buffer.alloc(32, 7),
    indexKey: Buffer.alloc(32, 9),
    ttlHours: 72,
  });
  return { repos, motor };
}

export function makeHarnessSweeper(
  ctx: ReturnType<typeof setupSweepContext>,
  provider: unknown,
  opts?: { sponsorEnabled?: boolean; sponsorThrows?: string; signer?: Signer },
) {
  const gasSponsor = opts?.sponsorThrows
    ? {
        enabled: true,
        address: '0xS',
        balance: async () => 0n,
        ensureGas: async () => {
          throw new Error(opts.sponsorThrows!);
        },
      }
    : {
        enabled: opts?.sponsorEnabled ?? false,
        address: opts?.sponsorEnabled ? '0xS' : null,
        balance: async () => 0n,
        ensureGas: async () => false,
      };
  return new Sweeper({
    repos: ctx.repos,
    providerFactory: () => provider as never,
    signer: opts?.signer ?? createTestSigner(),
    gasSponsor: gasSponsor as never,
    linkState: ctx.motor.linkState,
    logger: silentLogger,
    options: {
      gasSponsorAmountWei: 1n,
      gasSponsorMinBalanceWei: 1n,
      batchSize: 10,
      reconcileBatchSize: 10,
      tolerancePct: 1,
    },
  });
}

export async function seedPaidLink(ctx: ReturnType<typeof setupSweepContext>) {
  const perfil = await ctx.repos.rampProfiles.create({
    label: 'Polygon USDC',
    chain: 'polygon',
    asset: 'USDC',
    tokenContract: USDC,
    decimals: 6,
    fiatCurrency: 'BRL',
    baseUrl: 'https://buy.ramp.network/',
    paramStyle: 'legacy',
    hostAppName: 'Motor',
    hostApiKey: null,
    rampAssetKey: 'POLYGON_USDC',
    taxaTokenPorFiatBaseUnits: 180_000n,
  });
  await ctx.repos.coldWallets.create({
    label: 'Fria',
    address: CARTEIRA,
    chain: 'polygon',
  });
  const cliente = await ctx.motor.customers.create({
    nome: 'Maria Silva',
    email: 'maria@example.com',
  });
  const link = await ctx.motor.links.create({
    clienteId: cliente.id,
    amountCents: 10_000,
    rampProfileId: perfil.id,
    coldWalletAddress: CARTEIRA,
  });
  await ctx.repos.links.updateStatus(link.id, 'pago');
  return link;
}
