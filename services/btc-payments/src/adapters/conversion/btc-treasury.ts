import { UpstreamError } from '../../domain/errors.js';
import type { AppConfig } from '../../config.js';

export type TreasuryBtcSendInput = {
  conversionId: string;
  sourceAmountSats: bigint;
  inboundAddress: string;
  memo: string;
  refundAddress: string;
};

export type TreasuryBtcSendResult =
  | { kind: 'sent'; txid: string; rawTx?: string }
  | { kind: 'manual'; reason: string };

export interface TreasuryBtcSender {
  send(input: TreasuryBtcSendInput): Promise<TreasuryBtcSendResult>;
  describe(): string;
}

export class ManualTreasuryBtcSender implements TreasuryBtcSender {
  constructor(private readonly reason: string) {}

  async send(): Promise<TreasuryBtcSendResult> {
    return { kind: 'manual', reason: this.reason };
  }

  describe(): string {
    return 'manual(sem senhador de treasury configurado)';
  }
}

export type RemoteTreasuryBtcSenderOptions = {
  url: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * O senhador remoto recebe o pedido de gasto e devolve o raw tx assinado.
 * A API nunca ve a chave privada da treasury.
 */
export class RemoteTreasuryBtcSender implements TreasuryBtcSender {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RemoteTreasuryBtcSenderOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(input: TreasuryBtcSendInput): Promise<TreasuryBtcSendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.token
            ? { authorization: `Bearer ${this.opts.token}` }
            : {}),
        },
        body: JSON.stringify({
          conversion_id: input.conversionId,
          amount_sats: input.sourceAmountSats.toString(),
          inbound_address: input.inboundAddress,
          memo: input.memo,
          refund_address: input.refundAddress,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError('falha ao chamar senhador da treasury BTC', {
        cause: err,
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => undefined);
      throw new UpstreamError(
        `senhador da treasury respondeu HTTP ${response.status}`,
        { details: detail },
      );
    }
    const data = (await response.json().catch(() => null)) as {
      txid?: unknown;
      raw_tx?: unknown;
      manual?: unknown;
      reason?: unknown;
    } | null;
    if (!data) {
      throw new UpstreamError('senhador da treasury retornou JSON invalido');
    }
    if (data.manual === true) {
      return {
        kind: 'manual',
        reason:
          typeof data.reason === 'string' ? data.reason : 'assinatura manual',
      };
    }
    if (typeof data.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(data.txid)) {
      throw new UpstreamError('senhador da treasury nao retornou txid valido');
    }
    return {
      kind: 'sent',
      txid: data.txid.toLowerCase(),
      ...(typeof data.raw_tx === 'string' ? { rawTx: data.raw_tx } : {}),
    };
  }

  describe(): string {
    return `remote(${this.url})`;
  }
}

export function createTreasuryBtcSender(config: AppConfig): TreasuryBtcSender {
  if (!config.conversion.treasuryBtcSignerUrl) {
    return new ManualTreasuryBtcSender(
      'TREASURY_BTC_SIGNER_URL ausente; conversao aguarda envio manual',
    );
  }
  return new RemoteTreasuryBtcSender({
    url: config.conversion.treasuryBtcSignerUrl,
    ...(config.conversion.treasuryBtcSignerToken
      ? { token: config.conversion.treasuryBtcSignerToken }
      : {}),
    timeoutMs: config.conversion.timeoutMs,
  });
}
