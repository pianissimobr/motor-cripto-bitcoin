import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';

/**
 * Cliente SMTP mínimo, sem dependência externa.
 *
 * O motor roda em container e precisa enviar tres mensagens (verificação de
 * e-mail, redefinição de senha e aviso de troca de carteira). O relay é o
 * Postfix da máquina ou um provedor externo; aqui só o suficiente do
 * protocolo: EHLO, STARTTLS opcional, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA.
 *
 * Erros de rede viram `SmtpError` com a resposta do servidor, para o log
 * dizer o que o relay respondeu (o token do e-mail nunca entra no log).
 */

export type SmtpOptions = {
  host: string;
  port: number;
  /** TLS direto na conexão (porta 465). */
  secure: boolean;
  /** Upgrade para TLS depois do EHLO (porta 587). */
  starttls: boolean;
  user?: string;
  pass?: string;
  timeoutMs: number;
};

export type SmtpMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Data do cabecalho `Date:` (para mensagens deterministicas em teste). */
  date?: Date;
};

export class SmtpError extends Error {
  readonly code: string;
  readonly response: string | undefined;

  constructor(message: string, options: { code?: string; response?: string } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = options.code ?? 'smtp_error';
    this.response = options.response;
  }
}

/** Codifica um cabecalho em UTF-8 base64 quando tem caractere fora do ASCII. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Quebra linhas muito longas para caber no limite de 78/998 caracteres. */
function foldBody(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => {
      if (line.length <= 76) return line;
      const parts: string[] = [];
      let rest = line;
      while (rest.length > 76) {
        parts.push(rest.slice(0, 76));
        rest = rest.slice(76);
      }
      parts.push(rest);
      return parts.join('\r\n');
    })
    .join('\r\n');
}

export function buildMessage(
  message: SmtpMessage,
  from: string,
): string {
  const boundary = `b_${randomUUID().replace(/-/g, '')}`;
  const date = (message.date ?? new Date()).toUTCString();
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${date}`,
    `Message-ID: <${randomUUID()}@btc-payments>`,
    'MIME-Version: 1.0',
  ];

  if (message.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      foldBody(message.text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      foldBody(message.html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return escapeDotLines(`${headers.join('\r\n')}\r\n\r\n${body}`);
  }

  headers.push('Content-Type: text/plain; charset=UTF-8');
  headers.push('Content-Transfer-Encoding: 8bit');
  return escapeDotLines(
    `${headers.join('\r\n')}\r\n\r\n${foldBody(message.text)}\r\n`,
  );
}

/**
 * No corpo do e-mail uma linha que comeca com ponto encerra a mensagem: o
 * ponto solto e duplicado (RFC 5321).
 */
function escapeDotLines(body: string): string {
  return body.replace(/\r\n\./g, '\r\n..');
}

/**
 * Sessão SMTP: cada comando escreve uma linha e espera a resposta completa
 * (o relay pode responder em várias linhas, continuadas por `hifen`).
 */
class SmtpSession {
  private buffer = '';
  private waiters: Array<{
    resolve: (value: string) => void;
    reject: (err: unknown) => void;
  }> = [];

  constructor(
    private socket: Socket | TLSSocket,
    private readonly timeoutMs: number,
  ) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () =>
      this.fail(new SmtpError('conexao SMTP fechada', { code: 'smtp_closed' })),
    );
  }

  private fail(err: unknown): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(err);
  }

  /**
   * Extrai do buffer uma resposta completa. O relay responde em varias linhas
   * quando a ultima traz espaco depois do codigo (`250 `); as demais usam
   * hifen (`250-`) e a resposta so termina na ultima.
   */
  private flush(): void {
    if (this.waiters.length === 0) return;
    const lines = this.buffer.split('\r\n');
    const complete: string[] = [];
    let lastIndex = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]!;
      complete.push(line);
      if (/^\d{3} /.test(line)) {
        lastIndex = i;
        break;
      }
    }
    if (lastIndex < 0) return; // resposta ainda incompleta
    const consumed = complete.reduce((sum, line) => sum + line.length + 2, 0);
    this.buffer = this.buffer.slice(consumed);
    const waiter = this.waiters.shift()!;
    waiter.resolve(complete.join('\n'));
  }

  /** Le a proxima resposta completa do relay. */
  async readResponse(): Promise<string> {
    return this.readLine();
  }

  private readLine(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new SmtpError('timeout na resposta SMTP', { code: 'smtp_timeout' }),
        );
      }, this.timeoutMs);
      const waiter = {
        resolve: (value: string) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.waiters.push(waiter);
      this.flush();
    });
  }

  async write(data: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new SmtpError('timeout ao escrever no SMTP', { code: 'smtp_timeout' }),
        );
      }, this.timeoutMs);
      this.socket.write(data, 'utf8', (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async command(line: string): Promise<string> {
    await this.write(`${line}\r\n`);
    return this.readResponse();
  }

  /** Bytes crus para o corpo do e-mail (terminado por ponto). */
  async writeRaw(data: string): Promise<void> {
    await this.write(data);
  }

  upgrade(tls: { host: string; port: number; servername?: string }): SmtpSession {
    return new SmtpSession(
      tlsConnect({
        socket: this.socket,
        servername: tls.servername ?? tls.host,
        rejectUnauthorized: false,
      }),
      this.timeoutMs,
    );
  }

  end(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

function expectOk(response: string, command: string): void {
  const code = Number(response.slice(0, 3));
  if (!Number.isFinite(code) || code < 200 || code >= 400) {
    throw new SmtpError(`SMTP recusou ${command}: ${response}`, {
      code: 'smtp_rejected',
      response,
    });
  }
}

/**
 * Envia um e-mail. `from` e `to` sao enderecos de e-mail crus; o relay faz a
 * validacao final.
 */
export async function sendMail(
  options: SmtpOptions,
  from: string,
  message: SmtpMessage,
): Promise<void> {
  let socket: Socket | TLSSocket;
  if (options.secure) {
    socket = tlsConnect({
      host: options.host,
      port: options.port,
      servername: options.host,
      rejectUnauthorized: false,
    });
  } else {
    socket = netConnect({ host: options.host, port: options.port });
  }

  let session = new SmtpSession(socket, options.timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SmtpError('timeout ao conectar no SMTP', { code: 'smtp_timeout' })),
        options.timeoutMs,
      );
      socket.once(options.secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(
          new SmtpError(
            `falha ao conectar no SMTP: ${err instanceof Error ? err.message : String(err)}`,
            { code: 'smtp_connect_failed' },
          ),
        );
      });
    });

    expectOk(await session.readResponse(), 'greeting');
    let banner = await session.command('EHLO btc-payments');
    if (banner.startsWith('5')) {
      banner = await session.command('HELO btc-payments');
    }
    expectOk(banner, 'EHLO');

    if (!options.secure && options.starttls && /STARTTLS/i.test(banner)) {
      expectOk(await session.command('STARTTLS'), 'STARTTLS');
      session = session.upgrade({
        host: options.host,
        port: options.port,
        servername: options.host,
      });
      banner = await session.command('EHLO btc-payments');
      expectOk(banner, 'EHLO');
    }

    if (options.user) {
      const auth = await authenticate(session, options.user, options.pass ?? '');
      expectOk(auth, 'AUTH');
    }

    expectOk(await session.command(`MAIL FROM:<${from}>`), 'MAIL FROM');
    expectOk(await session.command(`RCPT TO:<${message.to}>`), 'RCPT TO');
    expectOk(await session.command('DATA'), 'DATA');

    const body = buildMessage(message, from).concat('\r\n.\r\n');
    await session.writeRaw(body);
    expectOk(await session.readResponse(), 'DATA');

    try {
      await session.command('QUIT');
    } catch {
      // Encerrar sem QUIT nao invalida o envio.
    }
  } finally {
    session.end();
  }
}

async function authenticate(
  session: SmtpSession,
  user: string,
  pass: string,
): Promise<string> {
  const banner = await session.command('EHLO btc-payments');
  if (/AUTH[ =-]PLAIN/i.test(banner)) {
    const payload = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
    return session.command(`AUTH PLAIN ${payload}`);
  }
  if (/AUTH[ =-]LOGIN/i.test(banner)) {
    await session.command('AUTH LOGIN');
    await session.write(
      `${Buffer.from(user, 'utf8').toString('base64')}\r\n`,
    );
    await session.readResponse();
    await session.write(
      `${Buffer.from(pass, 'utf8').toString('base64')}\r\n`,
    );
    return session.readResponse();
  }
  throw new SmtpError('SMTP nao anuncia AUTH PLAIN nem AUTH LOGIN', {
    code: 'smtp_no_auth',
    response: banner,
  });
}
