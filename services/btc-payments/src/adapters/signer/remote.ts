import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { UpstreamError } from '../../domain/errors.js';
import type {
  SweepSigner,
  SweepSignerRequest,
  SweepSignerResult,
} from './sweep-signer.js';

export type BtcRemoteSignerOptions = {
  url: string;
  token?: string;
  timeoutMs?: number;
};

export class BtcRemoteSigner implements SweepSigner {
  readonly mode = 'remote' as const;

  constructor(private readonly opts: BtcRemoteSignerOptions) {}

  async signSweep(request: SweepSignerRequest): Promise<SweepSignerResult> {
    let response: Response;
    try {
      response = await fetch(`${this.opts.url.replace(/\/+$/, '')}/sign`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.token
            ? { authorization: `Bearer ${this.opts.token}` }
            : {}),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new UpstreamError('falha ao chamar signer remoto', { cause: err });
    }
    if (!response.ok) {
      throw new UpstreamError(`signer remoto respondeu HTTP ${response.status}`);
    }
    const data = (await response.json()) as { psbt?: unknown; rawTx?: unknown };
    if (typeof data.rawTx === 'string') {
      const tx = btc.Transaction.fromRaw(hex.decode(data.rawTx));
      return {
        kind: 'signed',
        rawTx: data.rawTx,
        txid: tx.id,
        psbt: typeof data.psbt === 'string' ? data.psbt : '',
      };
    }
    if (typeof data.psbt !== 'string') {
      throw new UpstreamError('signer remoto nao retornou psbt/rawTx');
    }
    const tx = btc.Transaction.fromPSBT(hex.decode(data.psbt));
    try {
      tx.finalize();
    } catch {
      // O signer remoto pode ja ter finalizado o PSBT.
    }
    return {
      kind: 'signed',
      rawTx: hex.encode(tx.extract()),
      txid: tx.id,
      psbt: data.psbt,
    };
  }

  describe(): string {
    return `remote(${this.opts.url.replace(/\/+$/, '')})`;
  }
}
