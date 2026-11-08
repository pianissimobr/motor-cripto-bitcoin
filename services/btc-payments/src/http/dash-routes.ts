import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { ValidationError } from '../domain/errors.js';
import type { ApiClient } from '../domain/types.js';
import type { DashAuthService } from '../services/dash-auth-service.js';
import type { DashService } from '../services/dash-service.js';
import type { InvoiceService } from '../services/invoice-service.js';
import { dashSessionGuard } from './dash-session.js';

export type DashRoutesDeps = {
  config: AppConfig;
  auth: DashAuthService;
  dash: DashService;
  invoices?: InvoiceService;
};

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(`${what} invalido`, result.error.issues);
  return result.data;
}

const merchantParams = z.object({ merchantId: z.string().uuid() });
const withId = merchantParams.extend({ id: z.string().uuid() });
const paymentParams = withId.extend({ kind: z.enum(['pix', 'bitcoin', 'request']) });

const stepUp = z
  .object({
    password: z.string().min(1).max(200),
    request_id: z.string().trim().min(1).max(128).optional(),
    code: z.string().regex(/^\d{6}$/).optional(),
  })
  .strict();

const listQuery = z.object({
  kind: z.enum(['pix', 'bitcoin', 'request']).default('pix'),
  status: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)),
  external_id: z.string().trim().max(128).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Valor em reais/dolares como string decimal ("99.90") -> centavos. */
export function decimalToCents(value: string): bigint {
  const match = /^(\d{1,12})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new ValidationError('valor invalido: use 99.90');
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (cents <= 0n) throw new ValidationError('o valor deve ser maior que zero');
  return cents;
}

const paymentLinkSchema = z
  .object({
    amount: z.string().max(20),
    currency: z.enum(['BRL', 'USD']).default('BRL'),
    rails: z.array(z.enum(['pix', 'bitcoin', 'pix_direto'])).min(1).max(3).optional(),
    description: z.string().trim().max(200).optional(),
    external_id: z.string().trim().min(1).max(64).optional(),
    wallet_id: z.string().uuid().optional(),
    payer_tax_number: z.string().trim().min(11).max(18).optional(),
  })
  .strict();

/**
 * API do painel do lojista (`/v1/dash/*`). Sessao em cookie + CSRF nas
 * escritas, e toda rota com `:merchantId` confere que o usuario e membro da
 * loja. Nada aqui move dinheiro: so consulta e configura.
 */
export function registerDashRoutes(app: FastifyInstance, deps: DashRoutesDeps): void {
  const { dash, auth } = deps;
  const guard = dashSessionGuard(auth, deps.config);
  const opts = { preHandler: guard };

  const merchantOf = async (request: FastifyRequest): Promise<ApiClient> => {
    const { merchantId } = parse(merchantParams, request.params, 'loja');
    return dash.merchantFor(request.dashUser!, merchantId);
  };

  // Passo extra antes de operacao sensivel: confere a senha e manda o codigo.
  app.post('/v1/dash/step-up', { ...opts, config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (request) => {
    const body = parse(
      z.object({ password: z.string().min(1).max(200), altcha: z.string().max(4000).optional() }).strict(),
      request.body ?? {},
      'corpo',
    );
    const result = await auth.startStepUp(request.dashUser!, body.password, body.altcha);
    return { request_id: result.requestId, email_code: result.emailCode };
  });

  app.get('/v1/dash/merchants', opts, async (request) => ({
    merchants: (await dash.listMerchants(request.dashUser!)).map((m) => dash.merchantView(m)),
  }));

  app.get('/v1/dash/merchants/:merchantId', opts, async (request) => dash.merchantView(await merchantOf(request)));

  app.patch('/v1/dash/merchants/:merchantId', opts, async (request) => {
    const merchant = await merchantOf(request);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80).optional() }).strict(), request.body ?? {}, 'corpo');
    return dash.updateMerchant(request.dashUser!, merchant, body);
  });

  app.get('/v1/dash/merchants/:merchantId/overview', opts, async (request) => {
    const merchant = await merchantOf(request);
    const query = parse(z.object({ period: z.enum(['7d', '30d', '90d']).default('30d') }), request.query, 'consulta');
    return dash.overview(merchant, query.period);
  });

  app.get('/v1/dash/merchants/:merchantId/payments', opts, async (request) => {
    const merchant = await merchantOf(request);
    const query = parse(listQuery, request.query, 'consulta');
    return dash.listPayments(merchant, {
      kind: query.kind,
      status: query.status,
      externalId: query.external_id,
      from: query.from,
      to: query.to,
      cursor: query.cursor,
      limit: query.limit,
    });
  });

  app.get('/v1/dash/merchants/:merchantId/payments/:kind/:id', opts, async (request) => {
    const merchant = await merchantOf(request);
    const { kind, id } = parse(paymentParams, request.params, 'pagamento');
    return dash.paymentDetail(merchant, kind, id);
  });

  app.post('/v1/dash/merchants/:merchantId/payment-links', opts, async (request, reply) => {
    const merchant = await merchantOf(request);
    const body = parse(paymentLinkSchema, request.body ?? {}, 'corpo');
    const rails = body.rails ?? (body.payer_tax_number ? ['pix', 'bitcoin'] : ['bitcoin']);
    const created = await dash.createPaymentLink(request.dashUser!, merchant, {
      amountCents: decimalToCents(body.amount),
      currency: body.currency,
      rails,
      description: body.description,
      externalId: body.external_id,
      walletId: body.wallet_id,
      payerTaxNumber: body.payer_tax_number,
    });
    return reply.status(201).send(created);
  });

  // ---- carteiras

  app.get('/v1/dash/merchants/:merchantId/wallets', opts, async (request) => ({
    wallets: await dash.listWallets(await merchantOf(request)),
  }));

  app.post('/v1/dash/merchants/:merchantId/wallets', opts, async (request, reply) => {
    const merchant = await merchantOf(request);
    const body = parse(
      z.object({ address: z.string().trim().max(64), label: z.string().trim().max(60).optional(), step_up: stepUp }).strict(),
      request.body ?? {},
      'corpo',
    );
    const wallet = await dash.addWallet(request.dashUser!, merchant, {
      address: body.address,
      label: body.label,
      stepUp: body.step_up,
    });
    return reply.status(201).send(wallet);
  });

  app.post('/v1/dash/merchants/:merchantId/wallets/:id/default', opts, async (request) => {
    const merchant = await merchantOf(request);
    const { id } = parse(withId, request.params, 'carteira');
    const body = parse(z.object({ step_up: stepUp }).strict(), request.body ?? {}, 'corpo');
    return { wallets: await dash.setDefaultWallet(request.dashUser!, merchant, id, body.step_up) };
  });

  app.patch('/v1/dash/merchants/:merchantId/wallets/:id', opts, async (request) => {
    const merchant = await merchantOf(request);
    const { id } = parse(withId, request.params, 'carteira');
    const body = parse(z.object({ label: z.string().trim().max(60).nullable() }).strict(), request.body ?? {}, 'corpo');
    return { wallets: await dash.renameWallet(merchant, id, body.label) };
  });

  app.post('/v1/dash/merchants/:merchantId/wallets/:id/remove', opts, async (request) => {
    const merchant = await merchantOf(request);
    const { id } = parse(withId, request.params, 'carteira');
    const body = parse(z.object({ step_up: stepUp }).strict(), request.body ?? {}, 'corpo');
    return { wallets: await dash.removeWallet(request.dashUser!, merchant, id, body.step_up) };
  });

  app.get('/v1/dash/merchants/:merchantId/wallets/:id/balance', opts, async (request) => {
    const merchant = await merchantOf(request);
    const { id } = parse(withId, request.params, 'carteira');
    return dash.walletBalance(merchant, id);
  });

  // ---- integracao

  app.get('/v1/dash/merchants/:merchantId/integration', opts, async (request) =>
    dash.integrationView(await merchantOf(request)),
  );

  app.post('/v1/dash/merchants/:merchantId/credentials', opts, async (request, reply) => {
    const merchant = await merchantOf(request);
    const body = parse(z.object({ step_up: stepUp }).strict(), request.body ?? {}, 'corpo');
    const creds = await dash.rotateCredentials(request.dashUser!, merchant, body.step_up);
    return reply.status(201).header('cache-control', 'no-store').send(creds);
  });

  app.put('/v1/dash/merchants/:merchantId/webhook', opts, async (request) => {
    const merchant = await merchantOf(request);
    const body = parse(z.object({ url: z.string().trim().max(500).nullable() }).strict(), request.body ?? {}, 'corpo');
    return dash.setWebhookUrl(request.dashUser!, merchant, body.url || null);
  });

  app.post('/v1/dash/merchants/:merchantId/webhook/test', opts, async (request, reply) => {
    const merchant = await merchantOf(request);
    return reply.status(202).send(await dash.sendTestWebhook(merchant));
  });

  app.get('/v1/dash/merchants/:merchantId/webhook/events', opts, async (request) => {
    const merchant = await merchantOf(request);
    const query = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }), request.query, 'consulta');
    return { events: await dash.listWebhookEvents(merchant, query.limit) };
  });

  // ---- chaves de loja (plugins) e faturas

  const invoices = deps.invoices;
  if (invoices) {
    app.get('/v1/dash/merchants/:merchantId/store-keys', opts, async (request) => ({
      keys: await invoices.listStoreKeys((await merchantOf(request)).id),
    }));

    app.post('/v1/dash/merchants/:merchantId/store-keys', opts, async (request, reply) => {
      const merchant = await merchantOf(request);
      const body = parse(
        z.object({ mode: z.enum(['live', 'test']), label: z.string().trim().max(60).optional(), step_up: stepUp.optional() }).strict(),
        request.body ?? {},
        'corpo',
      );
      // Chave de producao recebe dinheiro de verdade: pede senha + codigo.
      if (body.mode === 'live') {
        if (!body.step_up) throw new ValidationError('confirme com sua senha para gerar a chave de producao');
        await auth.assertStepUp(request.dashUser!, {
          password: body.step_up.password,
          requestId: body.step_up.request_id,
          code: body.step_up.code,
        });
      }
      const created = await invoices.createStoreKey(merchant.id, body.mode, body.label, `painel:${request.dashUser!.id}`);
      return reply.status(201).header('cache-control', 'no-store').send(created);
    });

    app.post('/v1/dash/merchants/:merchantId/store-keys/:id/revoke', opts, async (request) => {
      const merchant = await merchantOf(request);
      const { id } = parse(withId, request.params, 'chave');
      await invoices.revokeStoreKey(merchant.id, id, `painel:${request.dashUser!.id}`);
      return { keys: await invoices.listStoreKeys(merchant.id) };
    });

    app.get('/v1/dash/merchants/:merchantId/invoices', opts, async (request) => {
      const merchant = await merchantOf(request);
      const query = parse(
        z.object({ mode: z.enum(['live', 'test']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
        request.query,
        'consulta',
      );
      const rows = await invoices.listForClient(merchant.id, { limit: query.limit, mode: query.mode });
      return { invoices: rows.map((row) => invoices.dto(row)) };
    });
  }

  app.post('/v1/dash/merchants/:merchantId/webhook/events/:id/replay', opts, async (request) => {
    const merchant = await merchantOf(request);
    const { id } = parse(withId, request.params, 'evento');
    return dash.replayWebhook(merchant, id);
  });
}
