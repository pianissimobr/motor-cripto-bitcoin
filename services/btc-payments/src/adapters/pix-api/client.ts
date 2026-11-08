import { Agent, fetch as undiciFetch } from 'undici';
import { UpstreamError, ValidationError } from '../../domain/errors.js';

/**
 * Cliente da API Pix padronizada pelo Banco Central (cobranca imediata,
 * `/v2/cob`), usada pela conta PJ da propria loja. Autentica com OAuth
 * client_credentials sobre mTLS (o certificado .p12 que o banco emite).
 *
 * Os bancos seguem o mesmo contrato da `cob`; muda o endereco e o jeito de
 * pedir o token, que ficam em `PSP_PRESETS`.
 */

export type PixPsp = 'efi' | 'inter' | 'outro';
export type PixEnvironment = 'producao' | 'homologacao';

type TokenStyle = 'basic-json' | 'form-body' | 'basic-form';

type Preset = { base: string; tokenUrl: string; tokenStyle: TokenStyle; scope?: string };

export const PSP_PRESETS: Record<Exclude<PixPsp, 'outro'>, Record<PixEnvironment, Preset>> = {
  efi: {
    producao: { base: 'https://pix.api.efipay.com.br', tokenUrl: 'https://pix.api.efipay.com.br/oauth/token', tokenStyle: 'basic-json' },
    homologacao: { base: 'https://pix-h.api.efipay.com.br', tokenUrl: 'https://pix-h.api.efipay.com.br/oauth/token', tokenStyle: 'basic-json' },
  },
  inter: {
    producao: {
      base: 'https://cdpj.partners.bancointer.com.br/pix',
      tokenUrl: 'https://cdpj.partners.bancointer.com.br/oauth/v2/token',
      tokenStyle: 'form-body',
      scope: 'cob.write cob.read',
    },
    homologacao: {
      base: 'https://cdpj-sandbox.partners.uatinter.co/pix',
      tokenUrl: 'https://cdpj-sandbox.partners.uatinter.co/oauth/v2/token',
      tokenStyle: 'form-body',
      scope: 'cob.write cob.read',
    },
  },
};

export type PixApiConfig = {
  psp: PixPsp;
  environment: PixEnvironment;
  /** So para `outro`: endereco base da API (antes de /v2) e do token. */
  baseUrl?: string | null;
  tokenUrl?: string | null;
  clientId: string;
  clientSecret: string;
  /** Certificado do cliente (.p12/.pfx) em base64, e a senha dele. */
  certificateP12Base64: string;
  certificatePassphrase?: string | null;
  pixKey: string;
};

export type PixCob = {
  txid: string;
  status: 'ATIVA' | 'CONCLUIDA' | 'REMOVIDA_PELO_USUARIO_RECEBEDOR' | 'REMOVIDA_PELO_PSP' | string;
  pixCopiaECola: string | null;
  /** Valor da cobranca em centavos. */
  amountCents: bigint;
  /** Pagamentos recebidos (endToEndId e valor em centavos). */
  payments: { endToEndId: string; amountCents: bigint }[];
};

export type PixFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; dispatcher?: unknown }) => Promise<{
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** "123.45" -> 12345n; recusa formato estranho. */
export function decimalToCents(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,13}\.\d{2}$/.test(value)) {
    throw new UpstreamError('valor da cobranca em formato inesperado');
  }
  return BigInt(value.replace('.', ''));
}

export function centsToDecimal(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export class PixApiClient {
  private readonly base: string;
  private readonly tokenUrl: string;
  private readonly tokenStyle: TokenStyle;
  private readonly scope: string | undefined;
  private readonly dispatcher: Agent;
  private readonly fetchImpl: PixFetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: PixApiConfig,
    opts: { fetchImpl?: PixFetch; ca?: string | Buffer; timeoutMs?: number } = {},
  ) {
    if (config.psp === 'outro') {
      if (!config.baseUrl || !config.tokenUrl) throw new ValidationError('informe o endereco da API e do token');
      this.base = config.baseUrl.replace(/\/+$/, '');
      this.tokenUrl = config.tokenUrl;
      this.tokenStyle = 'basic-form';
      this.scope = 'cob.write cob.read';
    } else {
      const preset = PSP_PRESETS[config.psp][config.environment];
      this.base = preset.base;
      this.tokenUrl = preset.tokenUrl;
      this.tokenStyle = preset.tokenStyle;
      this.scope = preset.scope;
    }
    let pfx: Buffer;
    try {
      pfx = Buffer.from(config.certificateP12Base64, 'base64');
    } catch {
      throw new ValidationError('certificado invalido');
    }
    this.dispatcher = new Agent({
      connect: {
        pfx,
        ...(config.certificatePassphrase ? { passphrase: config.certificatePassphrase } : {}),
        ...(opts.ca ? { ca: opts.ca } : {}),
        timeout: opts.timeoutMs ?? 15_000,
      },
      headersTimeout: opts.timeoutMs ?? 15_000,
      bodyTimeout: opts.timeoutMs ?? 15_000,
    });
    this.fetchImpl = opts.fetchImpl ?? (undiciFetch as unknown as PixFetch);
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    let headers: Record<string, string>;
    let body: string;
    if (this.tokenStyle === 'basic-json') {
      headers = { authorization: `Basic ${basic}`, 'content-type': 'application/json' };
      body = JSON.stringify({ grant_type: 'client_credentials' });
    } else if (this.tokenStyle === 'form-body') {
      headers = { 'content-type': 'application/x-www-form-urlencoded' };
      body = new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'client_credentials',
        ...(this.scope ? { scope: this.scope } : {}),
      }).toString();
    } else {
      headers = { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' };
      body = new URLSearchParams({ grant_type: 'client_credentials', ...(this.scope ? { scope: this.scope } : {}) }).toString();
    }
    const response = await this.send(this.tokenUrl, { method: 'POST', headers, body }, 'token');
    const data = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (response.status !== 200 || !data?.access_token) {
      throw new UpstreamError(
        response.status === 401 || response.status === 400
          ? 'o banco recusou o client_id/client_secret'
          : `o banco respondeu ${response.status} ao pedir o token`,
      );
    }
    this.token = { value: data.access_token, expiresAt: Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async send(url: string, init: { method: string; headers: Record<string, string>; body?: string }, what: string) {
    try {
      return await this.fetchImpl(url, { ...init, dispatcher: this.dispatcher });
    } catch (err) {
      // O undici embrulha o erro de TLS em "fetch failed"; o motivo vem em cause.
      const parts: string[] = [];
      let current: unknown = err;
      for (let depth = 0; current && depth < 4; depth++) {
        parts.push(current instanceof Error ? `${current.message} ${(current as { code?: string }).code ?? ''}` : String(current));
        current = current instanceof Error ? (current as { cause?: unknown }).cause : null;
      }
      const message = parts.join(' | ');
      if (/certificate|ssl|tls|pkcs12|mac verify|bad decrypt|unsupported pkcs12|ERR_OSSL/i.test(message)) {
        throw new UpstreamError(`certificado recusado ou invalido (${what})`, { cause: err });
      }
      throw new UpstreamError(`banco indisponivel (${what})`, { cause: err });
    }
  }

  private async api(method: string, path: string, payload?: unknown): Promise<{ status: number; data: unknown }> {
    const token = await this.getToken();
    const response = await this.send(
      `${this.base}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      },
      path.split('/')[2] ?? 'api',
    );
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }

  private parseCob(data: unknown): PixCob {
    const cob = data as {
      txid?: string;
      status?: string;
      pixCopiaECola?: string;
      valor?: { original?: string };
      pix?: { endToEndId?: string; valor?: string }[];
    };
    if (!cob || typeof cob.txid !== 'string' || typeof cob.status !== 'string') {
      throw new UpstreamError('resposta da cobranca Pix em formato inesperado');
    }
    return {
      txid: cob.txid,
      status: cob.status,
      pixCopiaECola: typeof cob.pixCopiaECola === 'string' ? cob.pixCopiaECola : null,
      amountCents: decimalToCents(cob.valor?.original),
      payments: (cob.pix ?? [])
        .filter((p) => typeof p.endToEndId === 'string')
        .map((p) => ({ endToEndId: p.endToEndId!, amountCents: decimalToCents(p.valor) })),
    };
  }

  /** Confere credenciais e certificado: pede o token. */
  async check(): Promise<void> {
    this.token = null;
    await this.getToken();
  }

  /** Cobranca imediata (idempotente pelo txid: repetir devolve a mesma). */
  async createCob(input: { txid: string; amountCents: bigint; expiresInSeconds: number; description: string }): Promise<PixCob> {
    if (!/^[a-zA-Z0-9]{26,35}$/.test(input.txid)) throw new ValidationError('txid invalido');
    const { status, data } = await this.api('PUT', `/v2/cob/${input.txid}`, {
      calendario: { expiracao: input.expiresInSeconds },
      valor: { original: centsToDecimal(input.amountCents) },
      chave: this.config.pixKey,
      solicitacaoPagador: input.description.slice(0, 140),
    });
    if (status === 200 || status === 201) return this.parseCob(data);
    // Ja existe (repeticao): busca a mesma.
    if (status === 409 || status === 400) {
      const existing = await this.getCob(input.txid).catch(() => null);
      if (existing) return existing;
    }
    const detail = (data as { detail?: string; mensagem?: string } | null)?.detail ?? (data as { mensagem?: string } | null)?.mensagem;
    throw new UpstreamError(`o banco recusou a cobranca Pix (${status}${detail ? `: ${detail}` : ''})`);
  }

  async getCob(txid: string): Promise<PixCob> {
    const { status, data } = await this.api('GET', `/v2/cob/${txid}`);
    if (status !== 200) throw new UpstreamError(`o banco respondeu ${status} ao consultar a cobranca`);
    return this.parseCob(data);
  }
}
