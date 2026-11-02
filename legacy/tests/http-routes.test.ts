import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { DomainError } from '../src/core/domain/errors.js';
import { registerRoutes } from '../src/adapters/http/routes.js';
import { silentLogger } from '../src/core/logger.js';
import type { Motor } from '../src/core/index.js';
import { TransferSubmissionError } from '../src/core/chain/sweeper.js';
import { WebhookService } from '../src/core/services/webhook-service.js';
import { setupCore } from './core-fixtures.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function buildRoutes(
  context: Awaited<ReturnType<typeof setupCore>>,
  sweeper: Motor['sweeper'] = {} as Motor['sweeper'],
) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const motor = {
    ...context,
    monitor: {},
    webhooks: new WebhookService({
      repos: context.repos,
      logger: silentLogger,
      timeoutMs: 1_000,
      maxAttempts: 1,
    }),
    sweeper,
    signer: {},
    gasSponsor: { balance: async () => 0n },
    providerFactory: () => {
      throw new Error('nao usado');
    },
  } as unknown as Motor;
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ erro: 'dados invalidos' });
    }
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({ erro: error.message, codigo: error.codigo });
    }
    return reply.code(500).send({ erro: 'erro interno' });
  });
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
    expect(page.body).toContain('/pay.js');
    expect(page.body).toContain(' UTC');
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

  it('recusa mudar o contrato de um perfil e responde 404 quando falta', async () => {
    const context = await setupCore();
    const app = await buildRoutes(context);
    const missing = '00000000-0000-4000-8000-000000000000';

    const frozen = await app.inject({
      method: 'PATCH',
      url: `/admin/api/ramp-profiles/${context.profile.id}`,
      payload: { token_contract: '0x0000000000000000000000000000000000000001' },
    });
    expect(frozen.statusCode).toBe(400);

    const absent = await app.inject({
      method: 'PATCH',
      url: `/admin/api/ramp-profiles/${missing}`,
      payload: { label: 'Outro nome' },
    });
    expect(absent.statusCode).toBe(404);

    const link = await app.inject({ method: 'GET', url: `/admin/api/links/${missing}` });
    expect(link.statusCode).toBe(404);

    const replay = await app.inject({
      method: 'POST',
      url: `/admin/api/webhooks/${missing}/replay`,
    });
    expect(replay.statusCode).toBe(404);
  });

  it('devolve o status real quando o submit do sweep falha', async () => {
    const context = await setupCore();
    const app = await buildRoutes(context, {
      submitSignedTransfer: async () => {
        throw new TransferSubmissionError('transferencia nao encontrada', 404);
      },
    } as unknown as Motor['sweeper']);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/sweeps/00000000-0000-4000-8000-000000000001/submit',
      payload: { raw_transaction: '0xabc' },
    });
    expect(response.statusCode).toBe(404);
  });
});
