import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { buildHttpApp } from '../src/adapters/http/app.js';
import { loadConfig } from '../src/core/config.js';
import { BlindIndex, DataCipher } from '../src/core/crypto/cipher.js';
import { CustomerService } from '../src/core/services/customer-service.js';
import { silentLogger } from '../src/core/logger.js';
import type { Motor } from '../src/core/index.js';
import { createFakeRepositories } from './fakes.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ADMIN_TOKEN: 'a'.repeat(32),
    READONLY_TOKEN: 'r'.repeat(32),
    DATABASE_URL: 'postgres://motor:senha@localhost:5432/motor',
    DATA_ENCRYPTION_KEY: KEY,
    DATA_INDEX_KEY: KEY,
    HD_XPUB: 'xpub6ExemploDeConta',
    ...overrides,
  };
}

async function makeApp(overrides: NodeJS.ProcessEnv = {}) {
  const repos = createFakeRepositories();
  const cipher = new DataCipher(Buffer.alloc(32, 1));
  const blindIndex = new BlindIndex(Buffer.alloc(32, 2));
  const customers = new CustomerService({ repos, cipher, blindIndex, logger: silentLogger });
  const motor = { customers, repos } as unknown as Motor;
  const config = loadConfig(baseEnv(overrides));
  const app = await buildHttpApp({
    motor,
    logger: silentLogger,
    config,
    serveStatic: false,
  });
  return { app, customers, repos, config };
}

const admin = { authorization: `Bearer ${'a'.repeat(32)}` };
const readonly = { authorization: `Bearer ${'r'.repeat(32)}` };

async function close(app: FastifyInstance): Promise<void> {
  await app.close();
}

describe('P1: auth por escopo', () => {
  it('health e publico e o resto exige token', async () => {
    const { app } = await makeApp();
    app.get('/api/ping', async () => ({ ok: true }));
    app.post('/api/ping', async () => ({ ok: true }));

    try {
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/ping' })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/api/ping', headers: admin })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/api/ping', headers: readonly })).statusCode,
      ).toBe(200);
      const negado = await app.inject({
        method: 'POST',
        url: '/api/ping',
        headers: readonly,
        payload: {},
      });
      expect(negado.statusCode).toBe(403);
      expect(negado.json()).toEqual({ erro: 'token sem permissao de escrita' });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/ping',
            headers: admin,
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await close(app);
    }
  });
});

describe('P1: PII mascarada + reveal auditado', () => {
  it('mascara por padrao, revela sob pedido e audita', async () => {
    const { app, customers, repos } = await makeApp();
    const created = await customers.create({ nome: 'Maria Silva', email: 'maria@example.com' });

    try {
      const mascarado = await app.inject({
        method: 'GET',
        url: '/api/cadastros?email=maria%40example.com',
        headers: admin,
      });
      expect(mascarado.statusCode).toBe(200);
      const c = mascarado.json().clientes[0];
      expect(c.email).toBeNull();
      expect(c.nome).not.toBe('Maria Silva');
      expect(c.nomeMasked).toBeTruthy();
      expect(c.emailMasked).toBeTruthy();

      const revelado = await app.inject({
        method: 'GET',
        url: '/api/cadastros?email=maria%40example.com&reveal=true',
        headers: admin,
      });
      const full = revelado.json().clientes[0];
      expect(full.nome).toBe('Maria Silva');
      expect(full.email).toBe('maria@example.com');

      const auditoria = await repos.audit.list(10);
      const evento = auditoria.find((e) => e.acao === 'pii.revelado');
      expect(evento).toBeTruthy();
      expect(evento?.entidadeId).toBe(created.id);
    } finally {
      await close(app);
    }
  });

  it('autocomplete nunca revela, mesmo com reveal=true', async () => {
    const { app, customers } = await makeApp();
    await customers.create({ nome: 'Joao Souza', email: 'joao@example.com' });

    try {
      const resp = await app.inject({
        method: 'GET',
        url: '/api/cadastros?q=joao&reveal=true',
        headers: admin,
      });
      expect(resp.statusCode).toBe(200);
      const c = resp.json().clientes[0];
      expect(c.email).toBeNull();
      expect(c.nome).not.toBe('Joao Souza');
    } finally {
      await close(app);
    }
  });

  it('criacao devolve somente mascaras', async () => {
    const { app } = await makeApp();
    try {
      const resp = await app.inject({
        method: 'POST',
        url: '/api/cadastros',
        headers: admin,
        payload: { nome: 'Ana Lima', email: 'ana@example.com' },
      });
      expect(resp.statusCode).toBe(201);
      const body = resp.json();
      expect(body.nome).not.toBe('Ana Lima');
      expect(body.email).toBeNull();
      expect(body.emailMasked).toBeTruthy();
    } finally {
      await close(app);
    }
  });
});

describe('P1: error handler global', () => {
  it('Zod vira 400 sem vazar detalhes internos', async () => {
    const { app } = await makeApp();
    app.get('/api/_zod', async () => {
      z.object({ a: z.string() }).parse({});
    });

    try {
      const resp = await app.inject({ method: 'GET', url: '/api/_zod', headers: admin });
      expect(resp.statusCode).toBe(400);
      expect(resp.json().erro).toBe('dados invalidos');
      expect(Array.isArray(resp.json().detalhes)).toBe(true);
    } finally {
      await close(app);
    }
  });

  it('erro inesperado vira 500 generico', async () => {
    const { app } = await makeApp();
    app.get('/api/_boom', async () => {
      throw new Error('segredo interno do banco');
    });

    try {
      const resp = await app.inject({ method: 'GET', url: '/api/_boom', headers: admin });
      expect(resp.statusCode).toBe(500);
      expect(resp.json()).toEqual({ erro: 'erro interno do servidor' });
      expect(resp.body).not.toContain('segredo interno');
    } finally {
      await close(app);
    }
  });
});

describe('P1: trustProxy configuravel', () => {
  it('nao confia em X-Forwarded-For por padrao', async () => {
    const { app } = await makeApp();
    app.get('/api/ip', async (request) => ({ ip: request.ip }));

    try {
      const resp = await app.inject({
        method: 'GET',
        url: '/api/ip',
        headers: { ...admin, 'x-forwarded-for': '203.0.113.7' },
      });
      expect(resp.json().ip).not.toBe('203.0.113.7');
    } finally {
      await close(app);
    }
  });

  it('confia quando TRUST_PROXY=true', async () => {
    const { app } = await makeApp({ TRUST_PROXY: 'true' });
    app.get('/api/ip', async (request) => ({ ip: request.ip }));

    try {
      const resp = await app.inject({
        method: 'GET',
        url: '/api/ip',
        headers: { ...admin, 'x-forwarded-for': '203.0.113.7' },
      });
      expect(resp.json().ip).toBe('203.0.113.7');
    } finally {
      await close(app);
    }
  });
});
