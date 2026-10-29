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
    trustProxy: false,
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
