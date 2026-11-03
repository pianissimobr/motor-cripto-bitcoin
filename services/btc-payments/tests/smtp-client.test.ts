import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMessage,
  sendMail,
  SmtpError,
} from '../src/adapters/email/smtp-client.js';

type FakeServer = {
  port: number;
  received: Array<{ from: string; to: string; data: string }>;
  close: () => Promise<void>;
};

/**
 * Relay SMTP de mentira: responde o protocolo minimo e guarda o que chegou.
 */
async function startFakeSmtp(
  options: { requireAuth?: boolean } = {},
): Promise<FakeServer> {
  const received: Array<{ from: string; to: string; data: string }> = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let inData = false;
    let from = '';
    let to = '';
    let data = '';

    socket.write('220 fake.smtp ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            received.push({ from, to, data });
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            data += `${line}\r\n`;
          }
        } else {
          const command = line.split(' ')[0]?.toUpperCase() ?? '';
          if (command === 'EHLO') {
            socket.write(
              options.requireAuth
                ? '250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10240000\r\n'
                : '250-fake.smtp\r\n250 SIZE 10240000\r\n',
            );
          } else if (command === 'HELO') {
            socket.write('250 fake.smtp\r\n');
          } else if (command === 'AUTH') {
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else if (command === 'MAIL') {
            from = line.slice(line.indexOf('<') + 1, line.indexOf('>'));
            socket.write('250 2.1.0 Ok\r\n');
          } else if (command === 'RCPT') {
            to = line.slice(line.indexOf('<') + 1, line.indexOf('>'));
            socket.write('250 2.1.5 Ok\r\n');
          } else if (command === 'DATA') {
            inData = true;
            data = '';
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (command === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 2.0.0 Ok\r\n');
          }
        }
        index = buffer.indexOf('\r\n');
      }
    });

    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const servers: FakeServer[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
});

describe('cliente SMTP', () => {
  it('entrega a mensagem no relay', async () => {
    const server = await startFakeSmtp();
    servers.push(server);

    await sendMail(
      {
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        starttls: false,
        timeoutMs: 5_000,
      },
      'motor@exemplo.com',
      {
        to: 'lojista@exemplo.com',
        subject: 'Confirme o seu e-mail',
        text: 'Codigo: 123456',
        html: '<p>Codigo: 123456</p>',
      },
    );

    expect(server.received).toHaveLength(1);
    const message = server.received[0]!;
    expect(message.from).toBe('motor@exemplo.com');
    expect(message.to).toBe('lojista@exemplo.com');
    expect(message.data).toContain('Subject: Confirme o seu e-mail');
    expect(message.data).toContain('To: lojista@exemplo.com');
    expect(message.data).toContain('Codigo: 123456');
    expect(message.data).toContain('multipart/alternative');
  });

  it('autentica quando o relay exige', async () => {
    const server = await startFakeSmtp({ requireAuth: true });
    servers.push(server);

    await sendMail(
      {
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        starttls: false,
        user: 'motor',
        pass: 'segredo',
        timeoutMs: 5_000,
      },
      'motor@exemplo.com',
      {
        to: 'lojista@exemplo.com',
        subject: 'Aviso',
        text: 'texto',
      },
    );

    expect(server.received).toHaveLength(1);
  });

  it('recusa quando o relay rejeita o comando', async () => {
    const server = await startFakeSmtp();
    servers.push(server);

    await expect(
      sendMail(
        {
          host: '127.0.0.1',
          port: server.port,
          secure: false,
          starttls: false,
          timeoutMs: 5_000,
        },
        'motor@exemplo.com',
        {
          to: 'lojista@exemplo.com',
          subject: 'Aviso',
          text: 'texto',
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('falha alto quando nao ha relay escutando', async () => {
    await expect(
      sendMail(
        {
          host: '127.0.0.1',
          port: 1,
          secure: false,
          starttls: false,
          timeoutMs: 2_000,
        },
        'motor@exemplo.com',
        {
          to: 'lojista@exemplo.com',
          subject: 'Aviso',
          text: 'texto',
        },
      ),
    ).rejects.toBeInstanceOf(SmtpError);
  });

  it('escapa o ponto solto no corpo', () => {
    const message = buildMessage(
      {
        to: 'lojista@exemplo.com',
        subject: 'Aviso',
        text: 'primeira linha\n.\nsegunda linha',
      },
      'motor@exemplo.com',
    );
    expect(message).toContain('\r\n..\r\n');
  });
});
