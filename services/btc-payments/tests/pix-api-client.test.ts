import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PixApiClient } from '../src/adapters/pix-api/client.js';

let hasOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  hasOpenssl = false;
}
const maybe = hasOpenssl ? describe : describe.skip;

/** Banco falso com mTLS: so atende quem apresenta certificado da CA dele. */
maybe('API Pix do banco (mTLS)', () => {
  let dir: string;
  let server: Server;
  let port: number;
  let ca: Buffer;
  let p12: string;
  const cobs = new Map<string, Record<string, unknown>>();
  const seen: { tokenAuth?: string | undefined; bearer?: string | undefined; clientCN?: string | undefined } = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pixapi-'));
    const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=Banco CA');
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1');
    ssl('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '1', '-copy_extensions', 'copy');
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'cli.key', '-out', 'cli.csr', '-subj', '/CN=loja-teste');
    ssl('x509', '-req', '-in', 'cli.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'cli.crt', '-days', '1');
    ssl('pkcs12', '-export', '-out', 'cli.p12', '-inkey', 'cli.key', '-in', 'cli.crt', '-passout', 'pass:senha-p12');
    ca = readFileSync(join(dir, 'ca.crt'));
    p12 = readFileSync(join(dir, 'cli.p12')).toString('base64');

    server = createServer(
      { key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.crt')), ca, requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        const cert = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
        seen.clientCN = cert.subject?.CN as string;
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const send = (status: number, data: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(data));
          };
          if (req.url === '/oauth/token') {
            seen.tokenAuth = req.headers.authorization;
            return send(200, { access_token: 'tok-1', expires_in: 3600 });
          }
          seen.bearer = req.headers.authorization;
          const match = /^\/v2\/cob\/(\w+)$/.exec(req.url ?? '');
          if (!match) return send(404, {});
          const txid = match[1]!;
          if (req.method === 'PUT') {
            const input = JSON.parse(body) as { valor: { original: string }; chave: string };
            const cob = { txid, status: 'ATIVA', valor: input.valor, chave: input.chave, pixCopiaECola: `00020126BR.GOV.BCB.PIX${txid}6304ABCD` };
            cobs.set(txid, cob);
            return send(201, cob);
          }
          const cob = cobs.get(txid);
          return cob ? send(200, cob) : send(404, {});
        });
      },
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const client = (overrides: Partial<ConstructorParameters<typeof PixApiClient>[0]> = {}) =>
    new PixApiClient(
      {
        psp: 'outro',
        environment: 'producao',
        baseUrl: `https://127.0.0.1:${port}`,
        tokenUrl: `https://127.0.0.1:${port}/oauth/token`,
        clientId: 'cid',
        clientSecret: 'csecret',
        certificateP12Base64: p12,
        certificatePassphrase: 'senha-p12',
        pixKey: 'loja@exemplo.com',
        ...overrides,
      },
      { ca },
    );

  it('pede o token com o certificado e cria e consulta a cobranca', async () => {
    const api = client();
    const txid = 'a'.repeat(32);
    const cob = await api.createCob({ txid, amountCents: 14_970n, expiresInSeconds: 3600, description: 'Pedido 11' });
    expect(cob).toMatchObject({ txid, status: 'ATIVA', amountCents: 14_970n });
    expect(cob.pixCopiaECola).toContain(txid);
    expect(seen.clientCN).toBe('loja-teste');
    expect(seen.tokenAuth).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(seen.bearer).toBe('Bearer tok-1');

    cobs.set(txid, { ...cobs.get(txid), status: 'CONCLUIDA', pix: [{ endToEndId: 'E1234567820261108', valor: '149.70' }] });
    const paid = await api.getCob(txid);
    expect(paid.status).toBe('CONCLUIDA');
    expect(paid.payments).toEqual([{ endToEndId: 'E1234567820261108', amountCents: 14_970n }]);
    await api.close();
  });

  it('senha do certificado errada: erro claro de certificado', async () => {
    const api = client({ certificatePassphrase: 'errada' });
    await expect(api.check()).rejects.toThrow(/certificado/);
    await api.close();
  });

  it('txid fora do padrao e recusado antes de chamar o banco', async () => {
    const api = client();
    await expect(api.createCob({ txid: 'curto', amountCents: 100n, expiresInSeconds: 60, description: 'x' })).rejects.toThrow(/txid/);
    await api.close();
  });
});
