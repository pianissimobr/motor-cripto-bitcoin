import { UpstreamError } from '../../domain/errors.js';
import type { Logger } from '../../logger.js';

export type EsploraUtxo = {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
  };
};

export type EsploraTxVout = {
  scriptpubkey_address?: string;
  value: number;
};

export type EsploraTx = {
  txid: string;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
  };
  vout: EsploraTxVout[];
  vin?: Array<{ txid: string; vout: number }>;
};

export type EsploraAddressStats = {
  address: string;
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
};

export type EsploraClientOptions = {
  url: string;
  timeoutMs?: number;
  logger?: Logger;
};

export class EsploraClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly logger?: Logger;

  constructor(opts: EsploraClientOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (opts.logger) this.logger = opts.logger;
  }

  async getTipHeight(): Promise<number> {
    const response = await this.request('/blocks/tip/height', { method: 'GET' });
    const text = (await response.text()).trim();
    const height = Number(text);
    if (!Number.isInteger(height) || height < 0) {
      throw new UpstreamError('Esplora retornou altura de bloco invalida');
    }
    return height;
  }

  async getAddressUtxos(address: string): Promise<EsploraUtxo[]> {
    const response = await this.request(
      `/address/${encodeURIComponent(address)}/utxo`,
      { method: 'GET' },
    );
    const data = (await this.parseJson(response)) as unknown;
    if (!Array.isArray(data)) {
      throw new UpstreamError('Esplora retornou UTXOs invalidos');
    }
    return data as EsploraUtxo[];
  }

  async getAddressStats(address: string): Promise<EsploraAddressStats> {
    const response = await this.request(
      `/address/${encodeURIComponent(address)}`,
      { method: 'GET' },
    );
    return (await this.parseJson(response)) as EsploraAddressStats;
  }

  async getTx(txid: string): Promise<EsploraTx> {
    const response = await this.request(`/tx/${encodeURIComponent(txid)}`, {
      method: 'GET',
    });
    return (await this.parseJson(response)) as EsploraTx;
  }

  async getFeeEstimates(): Promise<Record<string, number>> {
    const response = await this.request('/fee-estimates', { method: 'GET' });
    const data = (await this.parseJson(response)) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new UpstreamError('Esplora retornou estimativas de taxa invalidas');
    }
    return data as Record<string, number>;
  }

  async broadcastTx(rawHex: string): Promise<string> {
    if (!/^[0-9a-fA-F]+$/.test(rawHex) || rawHex.length % 2 !== 0) {
      throw new UpstreamError('transacao raw invalida para broadcast');
    }
    const response = await this.request('/tx', {
      method: 'POST',
      body: rawHex,
      contentType: 'text/plain',
    });
    const txid = (await response.text()).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new UpstreamError('Esplora retornou txid invalido no broadcast');
    }
    return txid;
  }

  async health(): Promise<{ ok: boolean; detail?: string; tipHeight?: number }> {
    try {
      const tipHeight = await this.getTipHeight();
      return { ok: true, tipHeight };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async request(
    path: string,
    init: {
      method: 'GET' | 'POST';
      body?: string;
      contentType?: string;
    },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: init.method,
        headers: {
          Accept: 'application/json',
          ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.logger?.warn({ err, path }, 'falha de rede ao chamar Esplora');
      throw new UpstreamError('falha ao chamar Esplora', { cause: err });
    }

    if (!response.ok) {
      let detail: unknown;
      try {
        detail = await response.text();
      } catch {
        detail = undefined;
      }
      this.logger?.warn(
        { path, status: response.status, detail },
        'Esplora retornou erro',
      );
      throw new UpstreamError(`Esplora respondeu HTTP ${response.status}`, {
        details: detail,
      });
    }
    return response;
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (err) {
      throw new UpstreamError('Esplora retornou JSON invalido', { cause: err });
    }
  }
}
