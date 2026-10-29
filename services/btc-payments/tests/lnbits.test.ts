import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LnbitsClient } from '../src/adapters/lnbits/client.js';

type Mock = {
  url: string;
  close: () => Promise<void>;
};

const servers: Mock[] = [];

async function startMock(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<Mock> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('sem porta');
  const mock: Mock = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(mock);
  return mock;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((mock) => mock.close()));
});

describe('lnbits client', () => {
  it('cria invoice e consulta pagamento', async () => {
    const mock = await startMock((req, res) => {
      if (req.url === '/api/v1/wallet' && req.method === 'GET') {
        res.end(JSON.stringify({ name: 'wallet', balance: 0 }));
        return;
      }
      if (req.url === '/api/v1/payments' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(body) as { amount: number; out: boolean };
          if (parsed.amount !== 10000 || parsed.out !== false) {
            res.statusCode = 400;
            res.end(JSON.stringify({ detail: 'payload invalido' }));
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              payment_hash: 'hash-123',
              payment_request: 'lnbc10u1p...',
              checking_id: 'check-1',
            }),
          );
        });
        return;
      }
      if (req.url === '/api/v1/payments/hash-123' && req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ payment_hash: 'hash-123', paid: true, amount: 10000 }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = new LnbitsClient({
      url: mock.url,
      apiKey: 'key',
      timeoutMs: 2_000,
    });

    const invoice = await client.createInvoice({
      amountSats: 10_000n,
      memo: 'Pedido 1',
      expiry: 600,
    });
    expect(invoice.payment_hash).toBe('hash-123');
    expect(invoice.payment_request).toBe('lnbc10u1p...');

    const payment = await client.getPayment('hash-123');
    expect(payment.paid).toBe(true);
    expect(payment.amount).toBe(10000);
    expect(await client.health()).toEqual({ ok: true });
  });

  it('normaliza a resposta aninhada do LNbits 1.6+', async () => {
    const mock = await startMock((req, res) => {
      if (req.url === '/api/v1/payments/hash-nested') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            paid: false,
            status: 'pending',
            details: {
              payment_hash: 'hash-nested',
              amount: 1_000_000,
              bolt11: 'lnbc10u1p...',
              checking_id: 'check-nested',
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const client = new LnbitsClient({
      url: mock.url,
      apiKey: 'key',
      timeoutMs: 2_000,
    });
    const payment = await client.getPayment('hash-nested');
    expect(payment.payment_hash).toBe('hash-nested');
    expect(payment.amount_msat).toBe(1_000_000);
    expect(payment.amount_sats).toBe(1000);
    expect(payment.payment_request).toBe('lnbc10u1p...');
    expect(payment.pending).toBe(true);
    expect(payment.paid).toBe(false);
  });

  it('reporta health falso quando o LNbits responde erro', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ detail: 'unauthorized' }));
    });
    const client = new LnbitsClient({ url: mock.url, apiKey: 'bad', timeoutMs: 2_000 });
    const health = await client.health();
    expect(health.ok).toBe(false);
  });
});
