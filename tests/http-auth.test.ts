import { createHash, createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthHook } from '../src/adapters/http/auth.js';
import { setupCore } from './core-fixtures.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function signature(secret: string, method: string, path: string, timestamp: number, nonce: string, body: string) {
  const canonical = [
    method,
    path,
    String(timestamp),
    nonce,
    createHash('sha256').update(body, 'utf8').digest('hex'),
  ].join('\n');
  return `v1=${createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')}`;
}

async function buildTestApp(context: Awaited<ReturnType<typeof setupCore>>) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = String(body);
    request.rawBody = raw;
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  app.addHook(
    'preValidation',
    createAuthHook({
      adminToken: 'admin-test',
      apiClients: context.apiClients,
      nonces: context.repos.nonces,
      timestampWindowSeconds: 300,
    }),
  );
  app.get('/v1/ping', async (request) => ({ ok: true, client: request.apiClient?.id }));
  app.post('/v1/echo', async (request) => ({ body: request.body }));
  app.get('/admin/api/status', async (request) => ({ scope: request.authScope }));
  app.get('/health', async () => ({ ok: true }));
  return app;
}

describe('HTTP auth', () => {
  it('aceita API key + HMAC e rejeita replay de nonce', async () => {
    const context = await setupCore();
    const app = await buildTestApp(context);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 'nonce-12345678';
    const body = JSON.stringify({ hello: 'world' });
    const headers = {
      authorization: `Bearer ${context.created.apiKey}`,
      'content-type': 'application/json',
      'x-timestamp': String(timestamp),
      'x-nonce': nonce,
      'x-signature': signature(
        context.created.requestSecret,
        'POST',
        '/v1/echo',
        timestamp,
        nonce,
        body,
      ),
    };

    const first = await app.inject({ method: 'POST', url: '/v1/echo', payload: body, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ body: { hello: 'world' } });

    const replay = await app.inject({ method: 'POST', url: '/v1/echo', payload: body, headers });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ erro: 'nonce ja utilizado' });
  });

  it('rejeita assinatura invalida, timestamp velho e ausencia de headers', async () => {
    const context = await setupCore();
    const app = await buildTestApp(context);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 'nonce-abcdefgh';
    const body = JSON.stringify({ a: 1 });
    const base = {
      authorization: `Bearer ${context.created.apiKey}`,
      'content-type': 'application/json',
      'x-timestamp': String(timestamp),
      'x-nonce': nonce,
    };

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      payload: body,
      headers: { ...base, 'x-signature': `v1=${'0'.repeat(64)}` },
    });
    expect(bad.statusCode).toBe(401);

    const stale = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      payload: body,
      headers: {
        ...base,
        'x-timestamp': String(timestamp - 10_000),
        'x-signature': signature(
          context.created.requestSecret,
          'POST',
          '/v1/echo',
          timestamp - 10_000,
          nonce,
          body,
        ),
      },
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ erro: 'X-Timestamp fora da janela permitida' });

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { authorization: `Bearer ${context.created.apiKey}` },
    });
    expect(missing.statusCode).toBe(401);
  });

  it('protege admin e mantem health publico', async () => {
    const context = await setupCore();
    const app = await buildTestApp(context);

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/api/status' })).statusCode).toBe(401);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/admin/api/status',
      headers: { authorization: 'Bearer errado' },
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'GET',
      url: '/admin/api/status',
      headers: { authorization: 'Bearer admin-test' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ scope: 'admin' });
  });
});
