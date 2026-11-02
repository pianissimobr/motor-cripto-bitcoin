import { sha256Hex } from '../../crypto/hmac.js';
import { UpstreamError } from '../../domain/errors.js';

export type SwapQuoteInput = {
  sourceAmountSats: bigint;
  targetAddress: string;
  refundAddress: string;
  /** Minimo aceitavel em unidades menores de USDC (6 casas). */
  minOutMinor?: bigint;
  slippageBps?: number;
};

export type SwapQuote = {
  provider: 'thorchain';
  providerOrderId: string;
  inboundAddress: string;
  memo: string;
  expectedAmountOutMinor: bigint;
  expiresAt: Date;
  sourceUrl: string;
  raw: Record<string, unknown>;
};

export type SwapStatus = {
  done: boolean;
  failed: boolean;
  refunded: boolean;
  outboundTxid: string | null;
  outboundAmountMinor: bigint | null;
  raw: Record<string, unknown>;
};

export interface SwapQuoteProvider {
  quote(input: SwapQuoteInput): Promise<SwapQuote>;
  getStatus(txid: string): Promise<SwapStatus>;
}

export type ThorchainClientOptions = {
  urls: string[];
  usdcAddress: string;
  timeoutMs?: number;
  quoteToleranceBps?: number;
  fetchImpl?: typeof fetch;
};

type RawQuote = {
  inbound_address?: unknown;
  memo?: unknown;
  expected_amount_out?: unknown;
  expiry?: unknown;
  fees?: unknown;
  warning?: unknown;
  notes?: unknown;
  [key: string]: unknown;
};

const THOR_BASE = 100_000_000n;
const USDC_MINOR = 1_000_000n;

export function thorToUsdcMinor(amount: bigint): bigint {
  if (amount < 0n) throw new Error('valor THORChain nao pode ser negativo');
  return (amount * USDC_MINOR) / THOR_BASE;
}

export function usdcMinorToThor(amount: bigint): bigint {
  if (amount < 0n) throw new Error('valor USDC nao pode ser negativo');
  return (amount * THOR_BASE) / USDC_MINOR;
}

export function thorchainAsset(usdcAddress: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(usdcAddress)) {
    throw new UpstreamError('endereco USDC invalido para THORChain');
  }
  return `BASE.USDC-${usdcAddress.toUpperCase()}`;
}

export class ThorchainClient implements SwapQuoteProvider {
  private readonly urls: string[];
  private readonly asset: string;
  private readonly timeoutMs: number;
  private readonly toleranceBps: bigint;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ThorchainClientOptions) {
    this.urls = opts.urls.map((url) => url.replace(/\/+$/, '')).filter(Boolean);
    if (this.urls.length === 0) {
      throw new Error('THORCHAIN_URLS vazio');
    }
    this.asset = thorchainAsset(opts.usdcAddress);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.toleranceBps = BigInt(opts.quoteToleranceBps ?? 50);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async quote(input: SwapQuoteInput): Promise<SwapQuote> {
    if (input.sourceAmountSats <= 0n) {
      throw new UpstreamError('valor BTC da conversao precisa ser positivo');
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(input.targetAddress)) {
      throw new UpstreamError('destino USDC invalido');
    }
    if (!input.refundAddress) {
      throw new UpstreamError('endereco de refund ausente');
    }

    let quotes = await this.fetchQuotes({
      ...input,
      ...(input.minOutMinor !== undefined ? { minOutMinor: input.minOutMinor } : {}),
    });

    const slippageBps = input.slippageBps ?? 0;
    if (input.minOutMinor === undefined && slippageBps > 0) {
      const first = this.choose(quotes);
      const minOut =
        (first.expectedAmountOutMinor * BigInt(10_000 - slippageBps)) / 10_000n;
      quotes = await this.fetchQuotes({ ...input, minOutMinor: minOut });
    }

    return this.choose(quotes);
  }

  async getStatus(txid: string): Promise<SwapStatus> {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new UpstreamError('txid THORChain invalido');
    }
    const errors: unknown[] = [];
    for (const url of this.urls) {
      try {
        const raw = (await this.getJson(
          `${url}/thorchain/tx/status/${encodeURIComponent(txid)}`,
        )) as Record<string, unknown>;
        return parseStatus(raw);
      } catch (err) {
        errors.push(err);
      }
    }
    throw new UpstreamError('nenhum endpoint THORChain respondeu o status', {
      details: errors.map((err) => (err instanceof Error ? err.message : String(err))),
      cause: errors[0],
    });
  }

  private async fetchQuotes(input: SwapQuoteInput): Promise<Array<{ quote: SwapQuote; url: string }>> {
    const results = await Promise.allSettled(
      this.urls.map(async (url) => {
        const quote = await this.requestQuote(url, input);
        return { quote, url };
      }),
    );
    const quotes = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (quotes.length === 0) {
      const errors = results.map((result) =>
        result.status === 'rejected'
          ? result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
          : '',
      );
      throw new UpstreamError('nenhum endpoint THORChain retornou quote', {
        details: errors,
        cause: results.find((result) => result.status === 'rejected')?.reason,
      });
    }
    return quotes;
  }

  private choose(quotes: Array<{ quote: SwapQuote; url: string }>): SwapQuote {
    const first = quotes[0]!.quote;
    const tolerance = this.toleranceBps;
    for (const candidate of quotes.slice(1)) {
      const other = candidate.quote;
      if (other.inboundAddress.toLowerCase() !== first.inboundAddress.toLowerCase()) {
        throw new UpstreamError('endpoints THORChain divergem no inbound address', {
          details: { first: first.inboundAddress, other: other.inboundAddress },
        });
      }
      if (other.memo !== first.memo) {
        throw new UpstreamError('endpoints THORChain divergem no memo', {
          details: { first: first.memo, other: other.memo },
        });
      }
      const diff =
        other.expectedAmountOutMinor > first.expectedAmountOutMinor
          ? other.expectedAmountOutMinor - first.expectedAmountOutMinor
          : first.expectedAmountOutMinor - other.expectedAmountOutMinor;
      const largest =
        first.expectedAmountOutMinor > other.expectedAmountOutMinor
          ? first.expectedAmountOutMinor
          : other.expectedAmountOutMinor;
      if (largest > 0n && diff * 10_000n > largest * tolerance) {
        throw new UpstreamError('endpoints THORChain divergem no valor esperado', {
          details: {
            first: first.expectedAmountOutMinor.toString(),
            other: other.expectedAmountOutMinor.toString(),
          },
        });
      }
    }
    return { ...first, sourceUrl: quotes[0]!.url };
  }

  private async requestQuote(url: string, input: SwapQuoteInput): Promise<SwapQuote> {
    const params = new URLSearchParams({
      from_asset: 'BTC.BTC',
      to_asset: this.asset,
      amount: input.sourceAmountSats.toString(),
      destination: input.targetAddress,
      refund_address: input.refundAddress,
      streaming_interval: '0',
      streaming_quantity: '0',
    });
    if (input.minOutMinor !== undefined && input.minOutMinor > 0n) {
      params.set('limit', usdcMinorToThor(input.minOutMinor).toString());
    }
    const raw = (await this.getJson(`${url}/thorchain/quote/swap?${params}`)) as RawQuote;
    return parseQuote(raw, url, input.sourceAmountSats);
  }

  private async getJson(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError('falha de rede ao chamar THORChain', { cause: err });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => undefined);
      throw new UpstreamError(`THORChain respondeu HTTP ${response.status}`, {
        details: detail,
      });
    }
    try {
      return await response.json();
    } catch (err) {
      throw new UpstreamError('THORChain retornou JSON invalido', { cause: err });
    }
  }
}

export function parseQuote(
  raw: RawQuote,
  sourceUrl: string,
  sourceAmountSats: bigint,
): SwapQuote {
  const inboundAddress = raw.inbound_address;
  const memo = raw.memo;
  const expected = raw.expected_amount_out;
  const expiry = raw.expiry;
  if (typeof inboundAddress !== 'string' || inboundAddress.length === 0) {
    throw new UpstreamError('THORChain nao retornou inbound_address');
  }
  if (typeof memo !== 'string' || memo.length === 0) {
    throw new UpstreamError('THORChain nao retornou memo');
  }
  if (typeof expected !== 'string' || !/^\d+$/.test(expected)) {
    throw new UpstreamError('THORChain nao retornou expected_amount_out');
  }
  if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0) {
    throw new UpstreamError('THORChain nao retornou expiry');
  }
  const expectedThor = BigInt(expected);
  const expectedMinor = thorToUsdcMinor(expectedThor);
  if (expectedMinor <= 0n) {
    throw new UpstreamError('THORChain retornou valor esperado zero');
  }
  return {
    provider: 'thorchain',
    providerOrderId: sha256Hex(
      `${inboundAddress}|${memo}|${sourceAmountSats.toString()}`,
    ).slice(0, 32),
    inboundAddress,
    memo,
    expectedAmountOutMinor: expectedMinor,
    expiresAt: new Date(expiry * 1000),
    sourceUrl,
    raw: raw as Record<string, unknown>,
  };
}

export function parseStatus(raw: Record<string, unknown>): SwapStatus {
  const outbound = asRecord(asRecord(raw.outbound_observed)?.tx);
  const observed = asRecord(asRecord(raw.observed_tx)?.tx);
  const outboundStatus =
    typeof outbound?.status === 'string' ? outbound.status : undefined;
  const observedStatus =
    typeof observed?.status === 'string' ? observed.status : undefined;
  const refunded =
    typeof outbound?.chain === 'string' && outbound.chain.toUpperCase() === 'BTC';
  const coins = Array.isArray(outbound?.coins) ? outbound.coins : [];
  const firstCoin = asRecord(coins[0]);
  const amount = firstCoin?.amount;
  return {
    done: outboundStatus === 'done',
    failed:
      outboundStatus === 'failed' ||
      observedStatus === 'failed' ||
      (typeof raw.error === 'string' && raw.error.length > 0),
    refunded: refunded && outboundStatus === 'done',
    outboundTxid:
      typeof outbound?.id === 'string'
        ? outbound.id
        : typeof outbound?.hash === 'string'
          ? outbound.hash
          : null,
    outboundAmountMinor:
      typeof amount === 'string' && /^\d+$/.test(amount)
        ? thorToUsdcMinor(BigInt(amount))
        : null,
    raw,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
