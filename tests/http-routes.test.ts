import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/adapters/http/routes.js';
import { silentLogger } from '../src/core/logger.js';
import type { Motor } from '../src/core/index.js';
import { setupCore } from './core-fixtures.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function buildRoutes(context: Awaited<ReturnType<typeof setupCore>>) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const motor = {
    ...context,
    monitor: {},
    sweeper: {},
    signer: {},
    gasSponsor: { balance: async () => 0n },
    providerFactory: () => {
      throw new Error('nao usado');
    },
  } as unknown as Motor;
  await registerRoutes(app, {
    motor,
    logger: silentLogger,
    gasSponsor: { minBalanceWei: 0n, configured: false },
  });
  return app;
}

describe('HTTP routes', () => {
  it('admin status retorna envelope data e metricas', async () => {
    const context = await setupCore();
    const app = await buildRoutes(context);
    const response = await app.inject({ method: 'GET', url: '/admin/api/status' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { clientes: number; perfis_ramp: number } };
    expect(body.data.clientes).toBe(1);
    expect(body.data.perfis_ramp).toBe(1);
  });

  it('serve a pagina publica e o status sem expor ramp_url', async () => {
    const context = await setupCore();
    const app = await buildRoutes(context);
    const { link } = await context.links.create({
      apiClienteId: context.created.client.id,
      externalId: 'rota-1',
      amountCents: 1_000,
      rampProfileId: context.profile.id,
      walletId: context.wallet.id,
    });

    const page = await app.inject({ method: 'GET', url: `/p/${link.pageToken}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Pagar com Ramp');
    expect(page.body).not.toContain('pageToken');

    const status = await app.inject({ method: 'GET', url: `/p/${link.pageToken}/status` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'aguardando',
      valor_fiat_centavos: 1_000,
      moeda_fiat: 'BRL',
    });
    expect(status.body).not.toContain('ramp_url');
  });

  it('revoga link pelo admin e devolve motivo', async () => {
    const context = await setupCore();
    const app = await buildRoutes(context);
    const { link } = await context.links.create({
      apiClienteId: context.created.client.id,
      externalId: 'rota-2',
      amountCents: 1_000,
      rampProfileId: context.profile.id,
      walletId: context.wallet.id,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/admin/api/links/${link.id}/revoke`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { status: 'nao_realizado', motivo_nao_realizado: 'revogado' },
    });
  });
});
