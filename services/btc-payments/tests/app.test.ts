import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { silentLogger } from '../src/logger.js';
import type { Readiness } from '../src/http/readiness.js';

const config = {
  service: {
    name: 'btc-payments' as const,
    version: '0.1.0',
  },
  server: {
    trustProxy: false as const,
    corsAllowedOrigins: ['http://localhost:4580'],
    rateLimitMax: 1_000,
    rateLimitWindowMs: 60_000,
  },
};

function readiness(ok: boolean): Readiness {
  return {
    checks: [
      { name: 'db', run: async () => ({ ok }) },
      { name: 'lnbits', run: async () => ({ ok }) },
    ],
  };
}

describe('http app', () => {
  it('responde /health sem depender de readiness', async () => {
    const app = buildApp({
      config,
      logger: silentLogger,
      readiness: readiness(false),
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: 'btc-payments',
      version: '0.1.0',
    });
    await app.close();
  });

  it('responde 200 em /ready quando todos os checks passam', async () => {
    const app = buildApp({
      config,
      logger: silentLogger,
      readiness: readiness(true),
    });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    await app.close();
  });

  it('responde 503 em /ready quando algum check falha', async () => {
    const app = buildApp({
      config,
      logger: silentLogger,
      readiness: readiness(false),
    });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().ok).toBe(false);
    await app.close();
  });

  it('responde 404 para rota desconhecida', async () => {
    const app = buildApp({
      config,
      logger: silentLogger,
      readiness: readiness(true),
    });
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
    await app.close();
  });
});

/**
 * O rate limit precisa valer de verdade: com as rotas registradas antes do
 * plugin carregar, ele nunca se aplicava (e producao ficou sem limite).
 */
describe('rate limit', () => {
  const build = (trustProxy: false | number) =>
    buildApp({
      config: { ...config, server: { ...config.server, trustProxy, rateLimitMax: 2 } },
      logger: silentLogger,
      readiness: readiness(true),
    });

  it('se aplica as rotas (a terceira chamada na janela e 429)', async () => {
    const app = build(false);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: 'GET', url: '/ready' })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    await app.close();
  });

  it('atras de 1 proxy, X-Forwarded-For forjado nao abre um balde novo', async () => {
    const app = build(1);
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/ready',
        remoteAddress: '127.0.0.1',
        // O nginx com $proxy_add_x_forwarded_for manda "<forjado>, <IP real>".
        headers: { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.5` },
      });
      codes.push(response.statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    await app.close();
  });

  it('clientes reais diferentes tem baldes diferentes', async () => {
    const app = build(1);
    for (let i = 0; i < 2; i++) {
      await app.inject({ method: 'GET', url: '/ready', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.5' } });
    }
    const other = await app.inject({ method: 'GET', url: '/ready', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.6' } });
    expect(other.statusCode).toBe(200);
    await app.close();
  });

  it('/health fica fora do limite', async () => {
    const app = build(false);
    for (let i = 0; i < 4; i++) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
    await app.close();
  });
});
