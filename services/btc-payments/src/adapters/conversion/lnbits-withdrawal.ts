import type { AppConfig } from '../../config.js';
import { UpstreamError } from '../../domain/errors.js';

export type LightningWithdrawalInput = {
  intentId: string;
  paymentHash: string;
  amountSats: bigint;
  address: string;
  memo: string;
};

export type LightningWithdrawalResult =
  | { kind: 'sent'; txid: string | null; providerRef: string | null }
  | { kind: 'manual'; reason: string };

export interface LightningTreasuryWithdrawal {
  withdraw(input: LightningWithdrawalInput): Promise<LightningWithdrawalResult>;
  describe(): string;
}

export class ManualLightningWithdrawal implements LightningTreasuryWithdrawal {
  async withdraw(): Promise<LightningWithdrawalResult> {
    return {
      kind: 'manual',
      reason: 'LNBITS_WITHDRAWAL_URL ausente; saque Lightning manual necessario',
    };
  }

  describe(): string {
    return 'manual(sem endpoint de saque LNbits)';
  }
}

export type HttpLnbitsWithdrawalOptions = {
  url: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Bridge HTTP para o saque on-chain do saldo Lightning da LNbits para a
 * treasury BTC. O endpoint deve aceitar {address, amount_sats, memo} e
 * devolver {txid} ou {manual:true, reason}.
 */
export class HttpLnbitsWithdrawal implements LightningTreasuryWithdrawal {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpLnbitsWithdrawalOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async withdraw(input: LightningWithdrawalInput): Promise<LightningWithdrawalResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/withdraw`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.token
            ? { authorization: `Bearer ${this.opts.token}` }
            : {}),
        },
        body: JSON.stringify({
          address: input.address,
          amount_sats: input.amountSats.toString(),
          memo: input.memo,
          payment_hash: input.paymentHash,
          idempotency_key: `lnbits-withdrawal:${input.intentId}`,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError('falha ao chamar saque da LNbits', { cause: err });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => undefined);
      throw new UpstreamError(`saque LNbits respondeu HTTP ${response.status}`, {
        details: detail,
      });
    }
    const data = (await response.json().catch(() => null)) as {
      txid?: unknown;
      provider_ref?: unknown;
      manual?: unknown;
      reason?: unknown;
    } | null;
    if (!data) {
      throw new UpstreamError('saque LNbits retornou JSON invalido');
    }
    if (data.manual === true) {
      return {
        kind: 'manual',
        reason:
          typeof data.reason === 'string' ? data.reason : 'saque manual necessario',
      };
    }
    return {
      kind: 'sent',
      txid:
        typeof data.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(data.txid)
          ? data.txid.toLowerCase()
          : null,
      providerRef:
        typeof data.provider_ref === 'string' ? data.provider_ref : null,
    };
  }

  describe(): string {
    return `http(${this.url})`;
  }
}

export function createLightningTreasuryWithdrawal(
  config: AppConfig,
): LightningTreasuryWithdrawal {
  if (!config.conversion.lnbitsWithdrawalUrl) {
    return new ManualLightningWithdrawal();
  }
  return new HttpLnbitsWithdrawal({
    url: config.conversion.lnbitsWithdrawalUrl,
    ...(config.conversion.lnbitsWithdrawalToken
      ? { token: config.conversion.lnbitsWithdrawalToken }
      : {}),
    timeoutMs: config.conversion.timeoutMs,
  });
}
