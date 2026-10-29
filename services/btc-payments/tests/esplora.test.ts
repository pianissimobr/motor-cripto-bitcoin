import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { EsploraClient } from '../src/adapters/chain/esplora.js';

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

describe('esplora client', () => {
  it('consulta tip, UTXOs, taxas e broadcast', async () => {
    const mock = await startMock((req, res) => {
      if (req.url === '/blocks/tip/height') {
        res.end('840000');
        return;
      }
      if (req.url?.startsWith('/address/') && req.url.endsWith('/utxo')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            {
              txid: 'a'.repeat(64),
              vout: 0,
              value: 10000,
              status: { confirmed: true, block_height: 839999, block_hash: 'b'.repeat(64) },
            },
          ]),
        );
        return;
      }
      if (req.url === '/fee-estimates') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ '6': 2.5 }));
        return;
      }
      if (req.url === '/tx' && req.method === 'POST') {
        res.end('c'.repeat(64));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const client = new EsploraClient({ url: mock.url, timeoutMs: 2_000 });
    expect(await client.getTipHeight()).toBe(840000);
    const utxos = await client.getAddressUtxos('bc1qtest');
    expect(utxos).toHaveLength(1);
    expect(utxos[0]!.value).toBe(10000);
    expect(await client.getFeeEstimates()).toEqual({ '6': 2.5 });
    expect(await client.broadcastTx('00')).toBe('c'.repeat(64));
    expect(await client.health()).toEqual({ ok: true, tipHeight: 840000 });
  });

  it('devolve erro de upstream em HTTP 500', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const client = new EsploraClient({ url: mock.url, timeoutMs: 2_000 });
    await expect(client.getTipHeight()).rejects.toThrow(/HTTP 500/);
  });
});
