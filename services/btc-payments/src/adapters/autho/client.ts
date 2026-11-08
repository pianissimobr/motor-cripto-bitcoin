import { createHmac, randomUUID } from 'node:crypto';
import { AppError, UpstreamError, ValidationError } from '../../domain/errors.js';

/**
 * Cliente do authO no perfil issuer (auth.libreflowdigital.com): emite e
 * confere codigos de 6 digitos por e-mail e aplica o anti-robo ALTCHA. O
 * authO nao conhece usuarios nem senhas; o motor continua dono das contas.
 *
 * Chamadas servidor-a-servidor assinadas:
 * HMAC-SHA256(secret, `${timestamp}.${nonce}.${rawBody}`) em hex.
 */
/** `login_2fa` serve de confirmacao de operacao sensivel no painel (step-up). */
export type AuthoPurpose = 'email_verification' | 'password_reset' | 'login_2fa';

export type AuthoIssuedCode = { requestId: string; email: string; expiresAt: string };
export type AuthoVerifiedCode = { email: string; purpose: string };

export type AuthoClientOptions = {
  url: string;
  tenant: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function signAuthoBody(secret: string, timestamp: string, nonce: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

export class AuthoIssuerClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AuthoClientOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Desafio ALTCHA para o navegador resolver. Null se o anti-robo estiver desligado. */
  async challenge(): Promise<unknown | null> {
    const response = await this.send('GET', '/issuer/altcha');
    if (response.status === 404) return null;
    return this.readJson(response, 'desafio anti-robo');
  }

  /** Confere uma solucao ALTCHA sem emitir codigo (ex.: login). */
  async verifyHuman(altcha: string): Promise<void> {
    const response = await this.signed('/issuer/altcha/verify', { altcha });
    await this.readJson(response, 'verificacao anti-robo');
  }

  async issueCode(input: {
    subject: string;
    email: string;
    purpose: AuthoPurpose;
    altcha?: string;
  }): Promise<AuthoIssuedCode> {
    const response = await this.signed('/issuer/codes', input);
    const data = (await this.readJson(response, 'envio do codigo')) as Partial<AuthoIssuedCode>;
    if (typeof data.requestId !== 'string') {
      throw new UpstreamError('authO nao devolveu requestId');
    }
    return {
      requestId: data.requestId,
      email: String(data.email ?? input.email),
      expiresAt: String(data.expiresAt ?? ''),
    };
  }

  async verifyCode(input: {
    requestId: string;
    subject: string;
    code: string;
  }): Promise<AuthoVerifiedCode> {
    const response = await this.signed('/issuer/codes/verify', input);
    const data = (await this.readJson(response, 'conferencia do codigo')) as Partial<
      AuthoVerifiedCode & { verified: boolean }
    >;
    if (data.verified !== true || typeof data.email !== 'string') {
      throw new ValidationError('codigo invalido');
    }
    return { email: data.email, purpose: String(data.purpose ?? '') };
  }

  private async signed(path: string, payload: Record<string, unknown>): Promise<Response> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    return this.send('POST', path, body, {
      'x-autho-tenant': this.opts.tenant,
      'x-autho-timestamp': timestamp,
      'x-autho-nonce': nonce,
      'x-autho-signature': signAuthoBody(this.opts.secret, timestamp, nonce, body),
    });
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError('authO indisponivel', { cause: err });
    }
  }

  /** Erros do authO viram erros do motor sem vazar detalhes internos. */
  private async readJson(response: Response, what: string): Promise<unknown> {
    const data = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    if (response.ok) return data;
    const code = data?.error?.code ?? '';
    if (response.status === 429) {
      throw new AppError('muitas tentativas; aguarde e tente de novo', {
        code: 'rate_limited',
        statusCode: 429,
      });
    }
    if (response.status >= 400 && response.status < 500) {
      if (code.startsWith('otp_') || code === 'validation_error') {
        throw new ValidationError(code === 'otp_expired' ? 'codigo expirado' : 'codigo invalido');
      }
      if (code.includes('human') || code.includes('altcha') || code.includes('bot')) {
        throw new ValidationError('verificacao anti-robo falhou; tente de novo');
      }
      throw new ValidationError(`${what} recusado pelo authO`);
    }
    throw new UpstreamError(`${what}: authO respondeu HTTP ${response.status}`);
  }
}
