import { describe, expect, it } from 'vitest';
import { AuthoIssuerClient, signAuthoBody } from '../src/adapters/autho/client.js';

function client(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const c = new AuthoIssuerClient({
    url: 'https://auth.example/',
    tenant: 'motor',
    secret: 's'.repeat(32),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch,
  });
  return { c, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('cliente authO (issuer)', () => {
  it('assina o corpo exato com HMAC(timestamp.nonce.body) e manda o tenant', async () => {
    const { c, calls } = client(() =>
      json(201, { requestId: 'req-1', email: 'a@b.com', purpose: 'email_verification', expiresAt: 'x' }),
    );
    const issued = await c.issueCode({ subject: 'user:1', email: 'a@b.com', purpose: 'email_verification', altcha: 'abc' });
    expect(issued.requestId).toBe('req-1');
    const { url, init } = calls[0]!;
    expect(url).toBe('https://auth.example/issuer/codes');
    const h = init.headers as Record<string, string>;
    expect(h['x-autho-tenant']).toBe('motor');
    expect(h['x-autho-signature']).toBe(
      signAuthoBody('s'.repeat(32), h['x-autho-timestamp']!, h['x-autho-nonce']!, init.body as string),
    );
  });

  it('codigo errado vira validation_error sem detalhe interno', async () => {
    const { c } = client(() => json(400, { error: { code: 'otp_invalid', message: 'Invalid code' } }));
    await expect(c.verifyCode({ requestId: 'r', subject: 's', code: '123456' })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'codigo invalido',
    });
  });

  it('desafio anti-robo desligado devolve null', async () => {
    const { c } = client(() => json(404, { error: { code: 'not_found' } }));
    expect(await c.challenge()).toBeNull();
  });
});
