import { UpstreamError } from '../../domain/errors.js';
import type { Logger } from '../../logger.js';

export type LnbitsInvoice = {
  payment_hash: string;
  payment_request: string;
  checking_id?: string;
  expiry?: number;
  amount_msat?: number;
  amount_sats?: number;
};

export type LnbitsPayment = {
  payment_hash: string;
  payment_request?: string;
  /** Campo original do LNbits. Em versoes novas vem em msat. */
  amount?: number;
  amount_msat?: number;
  amount_sats?: number;
  fee?: number;
  paid?: boolean;
  pending?: boolean;
  status?: string;
  expiry?: number;
  checking_id?: string;
  created_at?: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
};

export type LnbitsClientOptions = {
  url: string;
  apiKey: string;
  timeoutMs?: number;
  logger?: Logger;
  /** fetch usado nas chamadas; o LNbits do lojista usa um fetch que bloqueia a rede interna. */
  fetchImpl?: typeof fetch;
};

export class LnbitsClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LnbitsClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.url = opts.url.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (opts.logger) this.logger = opts.logger;
  }

  async createInvoice(input: {
    amountSats: bigint;
    memo: string;
    expiry: number;
    webhook?: string;
  }): Promise<LnbitsInvoice> {
    if (input.amountSats <= 0n) {
      throw new UpstreamError('valor da invoice precisa ser positivo');
    }
    if (input.amountSats > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new UpstreamError('valor da invoice acima do limite seguro');
    }
    if (!Number.isInteger(input.expiry) || input.expiry < 1) {
      throw new UpstreamError('expiracao da invoice invalida');
    }

    const payload: Record<string, unknown> = {
      out: false,
      amount: Number(input.amountSats),
      memo: input.memo,
      expiry: input.expiry,
    };
    if (input.webhook) payload.webhook = input.webhook;

    const response = await this.request('/api/v1/payments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = (await this.parseJson(response)) as Partial<LnbitsInvoice>;
    if (
      typeof data.payment_hash !== 'string' ||
      typeof data.payment_request !== 'string'
    ) {
      throw new UpstreamError('LNbits retornou invoice sem payment_hash/payment_request');
    }
    return {
      payment_hash: data.payment_hash,
      payment_request: data.payment_request,
      ...(typeof data.checking_id === 'string'
        ? { checking_id: data.checking_id }
        : {}),
      ...(typeof data.expiry === 'number' ? { expiry: data.expiry } : {}),
      ...(typeof data.amount_msat === 'number'
        ? {
            amount_msat: data.amount_msat,
            amount_sats: Math.floor(data.amount_msat / 1000),
          }
        : {}),
    };
  }

  async getPayment(paymentHash: string): Promise<LnbitsPayment> {
    if (!paymentHash) throw new UpstreamError('payment_hash obrigatorio');
    const response = await this.request(
      `/api/v1/payments/${encodeURIComponent(paymentHash)}`,
      { method: 'GET' },
    );
    const data = (await this.parseJson(response)) as Partial<LnbitsPayment> & {
      details?: Record<string, unknown>;
    };
    const details = data.details ?? {};
    const pick = (key: string): unknown => data[key] ?? details[key];

    const normalizedHash = pick('payment_hash');
    if (typeof normalizedHash !== 'string') {
      throw new UpstreamError('LNbits retornou pagamento sem payment_hash');
    }

    const rawAmount = pick('amount');
    const amountMsat =
      typeof rawAmount === 'number' && Number.isFinite(rawAmount)
        ? rawAmount
        : undefined;
    const status = typeof pick('status') === 'string' ? (pick('status') as string) : undefined;
    const paid =
      data.paid === true ||
      details.paid === true ||
      status === 'paid' ||
      status === 'complete' ||
      status === 'success';
    const pending =
      data.pending === true ||
      (details.pending === true) ||
      (!paid && status === 'pending');

    const paymentRequestRaw = pick('payment_request') ?? pick('bolt11');
    const checkingId = pick('checking_id');
    const expiry = pick('expiry');

    return {
      ...data,
      payment_hash: normalizedHash,
      ...(typeof paymentRequestRaw === 'string'
        ? { payment_request: paymentRequestRaw }
        : {}),
      ...(amountMsat !== undefined
        ? {
            amount_msat: amountMsat,
            amount_sats: Math.floor(amountMsat / 1000),
          }
        : {}),
      ...(typeof checkingId === 'string' ? { checking_id: checkingId } : {}),
      ...(typeof expiry === 'number' ? { expiry } : {}),
      paid,
      pending,
      ...(status ? { status } : {}),
      details,
    };
  }

  /**
   * Diz se a chave e uma Admin key (que gasta o saldo). Tenta pagar uma invoice
   * invalida: o LNbits confere a chave antes de ler o corpo, entao uma Invoice
   * key e recusada com 401/403, e uma Admin key passa da autenticacao e falha
   * so na invoice. Nenhum pagamento acontece: a invoice nao e decodificavel.
   * Retorna null quando a resposta nao permite concluir.
   */
  async isAdminKey(): Promise<boolean | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/api/v1/payments`, {
        method: 'POST',
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ out: true, bolt11: 'lnbc1motorcriptoverificacaodechave' }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return null;
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) return false;
    if (response.status >= 400 && response.status < 600) return true;
    return null;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await this.request('/api/v1/wallet', { method: 'GET' });
      if (!response.ok) {
        return { ok: false, detail: `HTTP ${response.status}` };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}${path}`, {
        method: init.method,
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.logger?.warn({ err, path }, 'falha de rede ao chamar LNbits');
      throw new UpstreamError('falha ao chamar LNbits', { cause: err });
    }

    if (!response.ok) {
      let detail: unknown;
      try {
        detail = await response.json();
      } catch {
        detail = await response.text().catch(() => undefined);
      }
      this.logger?.warn(
        { path, status: response.status, detail },
        'LNbits retornou erro',
      );
      throw new UpstreamError(`LNbits respondeu HTTP ${response.status}`, {
        details: detail,
      });
    }
    return response;
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (err) {
      throw new UpstreamError('LNbits retornou JSON invalido', { cause: err });
    }
  }
}
