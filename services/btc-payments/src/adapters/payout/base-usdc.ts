import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  getAddress,
  http,
  isAddress,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { AppConfig } from '../../config.js';

export type UsdcTransferInput = {
  to: string;
  amountMinor: bigint;
  idempotencyKey: string;
};

export type UsdcTransferResult =
  | { kind: 'sent'; txid: string }
  | { kind: 'manual'; reason: string };

export type UsdcConfirmation = {
  confirmed: boolean;
  reverted: boolean;
  blockNumber: bigint | null;
};

export interface UsdcPayoutAdapter {
  getAddress(): Address | null;
  getGasBalanceWei(): Promise<bigint>;
  transfer(input: UsdcTransferInput): Promise<UsdcTransferResult>;
  getConfirmation(txid: string): Promise<UsdcConfirmation>;
  describe(): string;
}

export type BaseUsdcPayoutOptions = {
  rpcUrls: string[];
  privateKey?: string;
  hotAddress?: string;
  usdcAddress: string;
  chainId?: number;
  timeoutMs?: number;
  signerUrl?: string;
  signerToken?: string;
  fetchImpl?: typeof fetch;
};

function normalizeAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} invalido`);
  return getAddress(value);
}

export class BaseUsdcPayoutAdapter implements UsdcPayoutAdapter {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;
  private readonly usdcAddress: Address;
  private readonly hotAddress: Address | null;
  private readonly signerUrl: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly signerToken: string | null;
  private readonly signTimeoutMs: number;

  constructor(opts: BaseUsdcPayoutOptions) {
    if (opts.rpcUrls.length === 0) throw new Error('BASE_RPC_URLS vazio');
    const chain = { ...base, id: opts.chainId ?? base.id };
    const transport = fallback(
      opts.rpcUrls.map((url) => http(url, { timeout: opts.timeoutMs ?? 15_000 })),
    );
    this.publicClient = createPublicClient({ chain, transport });
    this.usdcAddress = normalizeAddress(opts.usdcAddress, 'BASE_USDC_ADDRESS');
    this.account = opts.privateKey
      ? privateKeyToAccount(opts.privateKey as `0x${string}`)
      : null;
    this.walletClient = this.account
      ? createWalletClient({ account: this.account, chain, transport })
      : null;
    this.hotAddress = opts.hotAddress
      ? normalizeAddress(opts.hotAddress, 'PAYOUT_HOT_ADDRESS')
      : null;
    this.signerUrl = opts.signerUrl
      ? opts.signerUrl.replace(/\/+$/, '')
      : null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.signerToken = opts.signerToken ?? null;
    this.signTimeoutMs = opts.timeoutMs ?? 15_000;
  }

  getAddress(): Address | null {
    return this.account?.address ?? this.hotAddress;
  }

  async getGasBalanceWei(): Promise<bigint> {
    const address = this.getAddress();
    if (!address) throw new Error('carteira de payout sem endereco');
    return this.publicClient.getBalance({ address });
  }

  async transfer(input: UsdcTransferInput): Promise<UsdcTransferResult> {
    if (input.amountMinor <= 0n) {
      throw new Error('valor do payout precisa ser positivo');
    }
    const to = normalizeAddress(input.to, 'destino USDC');
    if (this.account && to === this.account.address) {
      return { kind: 'manual', reason: 'destino igual a carteira quente' };
    }
    if (this.signerUrl) {
      return this.remoteTransfer(to, input);
    }
    if (!this.walletClient || !this.account) {
      return {
        kind: 'manual',
        reason: 'BASE_PAYOUT_PRIVATE_KEY/PAYOUT_SIGNER_URL ausente; assinatura manual necessaria',
      };
    }
    const txid = await this.walletClient.writeContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, input.amountMinor],
      account: this.account,
      chain: this.walletClient.chain,
    });
    return { kind: 'sent', txid };
  }

  private async remoteTransfer(
    to: Address,
    input: UsdcTransferInput,
  ): Promise<UsdcTransferResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.signerUrl}/payout`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.signerToken
            ? { authorization: `Bearer ${this.signerToken}` }
            : {}),
        },
        body: JSON.stringify({
          asset: 'USDC',
          chain: 'base',
          chain_id: this.walletClient?.chain.id,
          usdc_address: this.usdcAddress,
          to,
          amount_minor: input.amountMinor.toString(),
          idempotency_key: input.idempotencyKey,
        }),
        signal: AbortSignal.timeout(this.signTimeoutMs),
      });
    } catch (err) {
      throw new Error(`falha ao chamar signer de payout: ${String(err)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => undefined);
      throw new Error(`signer de payout respondeu HTTP ${response.status}: ${detail ?? ''}`);
    }
    const data = (await response.json().catch(() => null)) as {
      txid?: unknown;
      manual?: unknown;
      reason?: unknown;
    } | null;
    if (!data) throw new Error('signer de payout retornou JSON invalido');
    if (data.manual === true) {
      return {
        kind: 'manual',
        reason: typeof data.reason === 'string' ? data.reason : 'assinatura manual',
      };
    }
    if (typeof data.txid !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(data.txid)) {
      throw new Error('signer de payout nao retornou txid valido');
    }
    return { kind: 'sent', txid: data.txid };
  }

  async getConfirmation(txid: string): Promise<UsdcConfirmation> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txid)) {
      throw new Error('txid Base invalido');
    }
    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: txid as Hash,
      });
      return {
        confirmed: receipt.status === 'success',
        reverted: receipt.status === 'reverted',
        blockNumber: receipt.blockNumber,
      };
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) {
        return { confirmed: false, reverted: false, blockNumber: null };
      }
      throw err;
    }
  }

  describe(): string {
    return `base-usdc(${this.usdcAddress})`;
  }
}

export function createUsdcPayoutAdapter(config: AppConfig): UsdcPayoutAdapter {
  return new BaseUsdcPayoutAdapter({
    rpcUrls: config.payout.baseRpcUrls,
    ...(config.payout.privateKey ? { privateKey: config.payout.privateKey } : {}),
    ...(config.payout.hotAddress ? { hotAddress: config.payout.hotAddress } : {}),
    usdcAddress: config.payout.usdcAddress,
    chainId: config.payout.baseChainId,
    timeoutMs: config.conversion.timeoutMs,
    ...(config.payout.signerUrl ? { signerUrl: config.payout.signerUrl } : {}),
    ...(config.payout.signerToken ? { signerToken: config.payout.signerToken } : {}),
  });
}
