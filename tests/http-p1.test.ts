import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { buildHttpApp } from '../src/adapters/http/app.js';
import { loadConfig } from '../src/core/config.js';
import { BlindIndex, DataCipher } from '../src/core/crypto/cipher.js';
import { NotFoundError, ValidationError } from '../src/core/domain/errors.js';
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
  return { app, customers, repos, config, motor };
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

  it('e-mail duplicado vira 409 (nao 500)', async () => {
    const { app } = await makeApp();
    const payload = { nome: 'Ana Lima', email: 'ana@example.com' };
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/cadastros',
            headers: admin,
            payload,
          })
        ).statusCode,
      ).toBe(201);

      const duplicado = await app.inject({
        method: 'POST',
        url: '/api/cadastros',
        headers: admin,
        payload: { nome: 'Ana Outra', email: 'ANA@example.com' },
      });
      expect(duplicado.statusCode).toBe(409);
      expect(duplicado.json()).toEqual({ erro: 'email ja cadastrado' });
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

describe('P1: validacao e erros de dominio', () => {
  it('creditos sem clienteId retorna 400 (nao 200)', async () => {
    const { app } = await makeApp();
    try {
      const resp = await app.inject({
        method: 'GET',
        url: '/api/creditos',
        headers: admin,
      });
      expect(resp.statusCode).toBe(400);
      expect(resp.json()).toEqual({ erro: 'informe clienteId' });
    } finally {
      await close(app);
    }
  });

  it('taxa negativa ou fracionaria em perfil Ramp vira 400', async () => {
    const { app } = await makeApp();
    const base = {
      label: 'Polygon USDC',
      chain: 'polygon',
      asset: 'USDC',
      tokenContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      baseUrl: 'https://buy.ramp.network/',
    };
    try {
      for (const taxa of ['-1', 1.5]) {
        const resp = await app.inject({
          method: 'POST',
          url: '/api/ramp-profiles',
          headers: admin,
          payload: { ...base, taxaTokenPorFiatBaseUnits: taxa },
        });
        expect(resp.statusCode).toBe(400);
      }

      const ok = await app.inject({
        method: 'POST',
        url: '/api/ramp-profiles',
        headers: admin,
        payload: { ...base, taxaTokenPorFiatBaseUnits: '180000' },
      });
      expect(ok.statusCode).toBe(201);
    } finally {
      await close(app);
    }
  });

  it('valor invalido no link vira 400 antes de chamar o core', async () => {
    const { app } = await makeApp();
    try {
      const resp = await app.inject({
        method: 'POST',
        url: '/api/links',
        headers: admin,
        payload: {
          valor: 'abc',
          rampProfileId: '00000000-0000-4000-8000-000000000000',
          coldWalletAddress: '0x1111111111111111111111111111111111111111',
        },
      });
      expect(resp.statusCode).toBe(400);
      expect(resp.json().erro).toMatch(/valor invalido/);
    } finally {
      await close(app);
    }
  });

  it('NotFoundError vira 404 e ValidationError vira 400', async () => {
    const { app } = await makeApp();
    app.get('/api/_nao_encontrado', async () => {
      throw new NotFoundError('nao achei');
    });
    app.get('/api/_invalido', async () => {
      throw new ValidationError('dado invalido');
    });
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/_nao_encontrado',
            headers: admin,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({ method: 'GET', url: '/api/_invalido', headers: admin })
        ).statusCode,
      ).toBe(400);
    } finally {
      await close(app);
    }
  });
});

describe('P1: perfis Ramp - PATCH e alerta de gas', () => {
  async function criarPerfil(repos: ReturnType<typeof createFakeRepositories>) {
    return repos.rampProfiles.create({
      label: 'Polygon USDC',
      chain: 'polygon',
      asset: 'USDC',
      tokenContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      decimals: 6,
      fiatCurrency: 'BRL',
      baseUrl: 'https://buy.ramp.network/',
      paramStyle: 'legacy',
      hostAppName: 'Motor',
      hostApiKey: 'segredo-host-api',
      rampAssetKey: 'POLYGON_USDC',
      taxaTokenPorFiatBaseUnits: 180_000n,
    });
  }

  it('atualiza a taxa, audita e nunca devolve hostApiKey', async () => {
    const { app, repos } = await makeApp();
    const perfil = await criarPerfil(repos);
    try {
      const resp = await app.inject({
        method: 'PATCH',
        url: `/api/ramp-profiles/${perfil.id}`,
        headers: admin,
        payload: { taxaTokenPorFiatBaseUnits: '200000' },
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.json().perfil.taxaTokenPorFiatBaseUnits).toBe('200000');
      expect(JSON.stringify(resp.json())).not.toContain('segredo-host-api');
      expect((await repos.rampProfiles.findById(perfil.id))?.taxaTokenPorFiatBaseUnits).toBe(
        200_000n,
      );
      const auditoria = await repos.audit.list(10);
      expect(auditoria.find((e) => e.acao === 'ramp_profile.atualizado')).toBeTruthy();

      const lista = await app.inject({
        method: 'GET',
        url: '/api/ramp-profiles',
        headers: admin,
      });
      expect(JSON.stringify(lista.json())).not.toContain('segredo-host-api');
    } finally {
      await close(app);
    }
  });

  it('rejeita body vazio, campo imutavel e id inexistente', async () => {
    const { app, repos } = await makeApp();
    const perfil = await criarPerfil(repos);
    try {
      const vazio = await app.inject({
        method: 'PATCH',
        url: `/api/ramp-profiles/${perfil.id}`,
        headers: admin,
        payload: {},
      });
      expect(vazio.statusCode).toBe(400);

      const imutavel = await app.inject({
        method: 'PATCH',
        url: `/api/ramp-profiles/${perfil.id}`,
        headers: admin,
        payload: { chain: 'ethereum' },
      });
      expect(imutavel.statusCode).toBe(400);

      const inexistente = await app.inject({
        method: 'PATCH',
        url: '/api/ramp-profiles/00000000-0000-4000-8000-000000000000',
        headers: admin,
        payload: { taxaTokenPorFiatBaseUnits: '1' },
      });
      expect(inexistente.statusCode).toBe(404);
    } finally {
      await close(app);
    }
  });

  it('token read-only nao pode atualizar perfil', async () => {
    const { app, repos } = await makeApp();
    const perfil = await criarPerfil(repos);
    try {
      const resp = await app.inject({
        method: 'PATCH',
        url: `/api/ramp-profiles/${perfil.id}`,
        headers: readonly,
        payload: { taxaTokenPorFiatBaseUnits: '1' },
      });
      expect(resp.statusCode).toBe(403);
    } finally {
      await close(app);
    }
  });

  it('consulta o saldo real do patrocinador na API de alertas', async () => {
    const repos = createFakeRepositories();
    await criarPerfil(repos);
    const config = loadConfig(
      baseEnv({ GAS_SPONSOR_PRIVATE_KEY: `0x${'1'.repeat(64)}` }),
    );
    const motor = {
      repos,
      gasSponsor: { balance: async () => 1n },
      providerFactory: () => ({}),
    } as unknown as Motor;
    const app = await buildHttpApp({
      motor,
      logger: silentLogger,
      config,
      serveStatic: false,
    });
    try {
      const resp = await app.inject({
        method: 'GET',
        url: '/api/alerts',
        headers: admin,
      });
      expect(resp.statusCode).toBe(200);
      const alerta = resp
        .json()
        .alertas.find((a: { codigo: string }) => a.codigo === 'gas_sponsor_saldo_baixo');
      expect(alerta?.nivel).toBe('critico');
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

describe('P1: submissao manual de raw PSBT', () => {
  it('so admin submete e o corpo e validado antes do sweeper', async () => {
    const { app, motor } = await makeApp();
    const submit = vi.fn(async () => ({
      id: '00000000-0000-4000-8000-000000000000',
      txHash: '0x' + 'ab'.repeat(32),
      status: 'enviado' as const,
    }));
    (motor as unknown as { sweeper: unknown }).sweeper = { submitSignedTransfer: submit };
    const id = '00000000-0000-4000-8000-000000000000';
    const raw = '0x' + 'ab'.repeat(100);

    try {
      const negado = await app.inject({
        method: 'POST',
        url: `/api/movimentos/${id}/raw`,
        headers: readonly,
        payload: { rawTransaction: raw },
      });
      expect(negado.statusCode).toBe(403);

      const invalido = await app.inject({
        method: 'POST',
        url: `/api/movimentos/${id}/raw`,
        headers: admin,
        payload: { rawTransaction: 'curto' },
      });
      expect(invalido.statusCode).toBe(400);
      expect(submit).not.toHaveBeenCalled();

      const ok = await app.inject({
        method: 'POST',
        url: `/api/movimentos/${id}/raw`,
        headers: admin,
        payload: { rawTransaction: raw },
      });
      expect(ok.statusCode).toBe(202);
      expect(submit).toHaveBeenCalledWith(id, raw);
      expect(ok.json().status).toBe('enviado');
    } finally {
      await close(app);
    }
  });
});
