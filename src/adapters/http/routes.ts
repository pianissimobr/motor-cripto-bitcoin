import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ValidationError } from '../../core/domain/errors.js';
import { collectAlerts, type GasSponsorBalance } from '../../core/alerts.js';
import type { Motor } from '../../core/index.js';
import type { Logger } from '../../core/logger.js';
import type { ApiClient } from '../../core/domain/types.js';
import { TransferSubmissionError } from '../../core/chain/sweeper.js';
import { renderPaymentPage } from './payment-page.js';
import {
  adminClientDto,
  auditDto,
  linkDto,
  paymentDto,
  rampProfileDto,
  transferDto,
  walletDto,
  webhookDto,
} from './serializers.js';

const uuid = z.string().uuid();
function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const httpUrl = z.string().url().refine(isHttpUrl, 'use http(s)');

const createLinkSchema = z
  .object({
    external_id: z.string().trim().min(1).max(200),
    amount_cents: z.number().int().positive().max(100_000_000),
    ramp_profile_id: uuid,
    wallet_id: uuid,
    final_url: httpUrl.nullish(),
  })
  .strict();

const createClientSchema = z
  .object({
    nome: z.string().trim().min(2).max(200),
    webhook_url: httpUrl,
  })
  .strict();

const updateClientSchema = z
  .object({
    nome: z.string().trim().min(2).max(200).optional(),
    webhook_url: httpUrl.optional(),
    status: z.enum(['ativo', 'inativo']).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'informe ao menos um campo');

const createWalletSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    chain: z.string().trim().min(1).max(40),
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  })
  .strict();

const taxaSchema = z
  .union([
    z.string().regex(/^\d+$/),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : BigInt(value)));

const rampProfileSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    chain: z.string().trim().min(1).max(40),
    asset: z.string().trim().min(1).max(20),
    token_contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    decimals: z.number().int().min(0).max(18).default(6),
    fiat_currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .transform((value) => value.toUpperCase())
      .default('BRL'),
    base_url: httpUrl,
    param_style: z.enum(['legacy', 'unified']).default('legacy'),
    host_app_name: z.string().trim().min(1).max(80).default('Motor Cripto'),
    host_logo_url: httpUrl.nullish(),
    host_api_key: z.string().max(500).nullish(),
    ramp_asset_key: z.string().trim().max(80).nullish(),
    taxa_token_por_fiat_base_units: taxaSchema,
  })
  .strict();

const rampProfilePatchSchema = rampProfileSchema
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'informe ao menos um campo');

const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

export type RouteOptions = {
  motor: Motor;
  logger: Logger;
  gasSponsor: {
    minBalanceWei: bigint;
    configured: boolean;
    balances?: () => Promise<GasSponsorBalance[]>;
  };
};

export async function registerRoutes(app: FastifyInstance, options: RouteOptions): Promise<void> {
  const { motor, logger } = options;

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  /* ---------------------------------------------------------------- */
  /* Pagina publica                                                    */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { token: string } }>('/p/:token', async (request, reply) => {
    try {
      const link = await motor.links.getPublicByToken(request.params.token);
      return reply
        .header('cache-control', 'no-store')
        .header('x-robots-tag', 'noindex, nofollow')
        .type('text/html; charset=utf-8')
        .send(await renderPaymentPage(link));
    } catch {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send('<!doctype html><meta charset="utf-8"><title>Nao encontrado</title><p>Pagina nao encontrada.</p>');
    }
  });

  app.get<{ Params: { token: string } }>('/p/:token/status', async (request, reply) => {
    try {
      const link = await motor.links.getPublicByToken(request.params.token);
      return reply.header('cache-control', 'no-store').send({
        status: link.status,
        motivo_nao_realizado: link.motivoNaoRealizado,
        valor_fiat_centavos: link.valorFiatCentavos,
        moeda_fiat: link.moedaFiat,
        valor_recebido_base_units: link.valorRecebidoBaseUnits.toString(),
        expira_em: link.expiraEm.toISOString(),
        liquidacao_ate: link.liquidacaoAte.toISOString(),
      });
    } catch {
      return reply.code(404).send({ erro: 'pagina nao encontrada' });
    }
  });

  /* ---------------------------------------------------------------- */
  /* API do cliente                                                    */
  /* ---------------------------------------------------------------- */

  app.post('/v1/links', async (request, reply) => {
    const client = requireApiClient(request);
    const body = createLinkSchema.parse(request.body ?? {});
    const idempotencyKey = headerString(request, 'idempotency-key');
    const result = await motor.links.create({
      apiClienteId: client.id,
      externalId: body.external_id,
      idempotencyKey,
      amountCents: body.amount_cents,
      rampProfileId: body.ramp_profile_id,
      walletId: body.wallet_id,
      finalUrl: body.final_url ?? null,
      actor: `api:${client.id}`,
      ip: request.ip,
    });
    return reply.code(result.reused ? 200 : 201).send({
      data: linkDto(result.link, result.pageUrl),
      reused: result.reused,
    });
  });

  app.get<{ Params: { id: string } }>('/v1/links/:id', async (request) => {
    const client = requireApiClient(request);
    const link = await motor.links.getForClient(client.id, request.params.id);
    return { data: linkDto(link, motor.links.pageUrl(link.pageToken)) };
  });

  app.get('/v1/links', async (request) => {
    const client = requireApiClient(request);
    const query = limitSchema.parse((request.query as { limit?: string }).limit ?? 50);
    const links = await motor.links.listForClient(client.id, query);
    return {
      data: links.map((link) => linkDto(link, motor.links.pageUrl(link.pageToken))),
    };
  });

  app.post<{ Params: { id: string } }>('/v1/links/:id/revoke', async (request) => {
    const client = requireApiClient(request);
    await motor.links.getForClient(client.id, request.params.id);
    const link = await motor.links.revoke(
      request.params.id,
      `api:${client.id}`,
      request.ip,
    );
    return { data: linkDto(link, motor.links.pageUrl(link.pageToken)) };
  });

  app.get('/v1/ramp-profiles', async () => {
    const profiles = await motor.repos.rampProfiles.list();
    return { data: profiles.map(rampProfileDto) };
  });

  app.get('/v1/wallets', async (request) => {
    const client = requireApiClient(request);
    const wallets = await motor.apiClients.listWallets(client.id);
    return { data: wallets.map(walletDto) };
  });

  /* ---------------------------------------------------------------- */
  /* Admin                                                             */
  /* ---------------------------------------------------------------- */

  app.post('/admin/api/clientes', async (request, reply) => {
    const body = createClientSchema.parse(request.body ?? {});
    const created = await motor.apiClients.create({
      nome: body.nome,
      webhookUrl: body.webhook_url,
      ip: request.ip,
    });
    return reply.code(201).send({
      data: adminClientDto(created.client),
      api_key: created.apiKey,
      request_secret: created.requestSecret,
      webhook_secret: created.client.webhookSecret,
    });
  });

  app.get('/admin/api/clientes', async () => {
    const clients = await motor.apiClients.list();
    return { data: clients.map(adminClientDto) };
  });

  app.get<{ Params: { id: string } }>('/admin/api/clientes/:id', async (request) => {
    const client = await motor.apiClients.get(request.params.id);
    const wallets = await motor.apiClients.listWallets(client.id);
    return { data: { ...adminClientDto(client), wallets: wallets.map(walletDto) } };
  });

  app.patch<{ Params: { id: string } }>('/admin/api/clientes/:id', async (request) => {
    const body = updateClientSchema.parse(request.body ?? {});
    const client = await motor.apiClients.update(request.params.id, {
      ...(body.nome !== undefined ? { nome: body.nome } : {}),
      ...(body.webhook_url !== undefined ? { webhookUrl: body.webhook_url } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    return { data: adminClientDto(client) };
  });

  app.post<{ Params: { id: string } }>('/admin/api/clientes/:id/rotate-key', async (request) => {
    const rotated = await motor.apiClients.rotateKey(request.params.id);
    return {
      data: adminClientDto(rotated.client),
      api_key: rotated.apiKey,
      request_secret: rotated.requestSecret,
    };
  });

  app.post<{ Params: { id: string } }>(
    '/admin/api/clientes/:id/rotate-webhook-secret',
    async (request) => {
      const rotated = await motor.apiClients.rotateWebhookSecret(request.params.id);
      return { data: adminClientDto(rotated.client), webhook_secret: rotated.webhookSecret };
    },
  );

  app.get<{ Params: { id: string } }>('/admin/api/clientes/:id/wallets', async (request) => {
    const wallets = await motor.apiClients.listWallets(request.params.id);
    return { data: wallets.map(walletDto) };
  });

  app.post<{ Params: { id: string } }>('/admin/api/clientes/:id/wallets', async (request, reply) => {
    const body = createWalletSchema.parse(request.body ?? {});
    const wallet = await motor.apiClients.addWallet(request.params.id, body);
    return reply.code(201).send({ data: walletDto(wallet) });
  });

  app.get('/admin/api/ramp-profiles', async () => {
    const profiles = await motor.repos.rampProfiles.list();
    return { data: profiles.map(rampProfileDto) };
  });

  app.post('/admin/api/ramp-profiles', async (request, reply) => {
    const body = rampProfileSchema.parse(request.body ?? {});
    const profile = await motor.repos.rampProfiles.create({
      label: body.label,
      chain: body.chain,
      asset: body.asset,
      tokenContract: body.token_contract,
      decimals: body.decimals,
      fiatCurrency: body.fiat_currency,
      baseUrl: body.base_url,
      paramStyle: body.param_style,
      hostAppName: body.host_app_name,
      hostLogoUrl: body.host_logo_url ?? null,
      hostApiKey: body.host_api_key ?? null,
      rampAssetKey: body.ramp_asset_key ?? null,
      taxaTokenPorFiatBaseUnits: body.taxa_token_por_fiat_base_units,
    });
    return reply.code(201).send({ data: rampProfileDto(profile) });
  });

  app.patch<{ Params: { id: string } }>('/admin/api/ramp-profiles/:id', async (request) => {
    const body = rampProfilePatchSchema.parse(request.body ?? {});
    const profile = await motor.repos.rampProfiles.update(request.params.id, {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.fiat_currency !== undefined ? { fiatCurrency: body.fiat_currency } : {}),
      ...(body.base_url !== undefined ? { baseUrl: body.base_url } : {}),
      ...(body.param_style !== undefined ? { paramStyle: body.param_style } : {}),
      ...(body.host_app_name !== undefined ? { hostAppName: body.host_app_name } : {}),
      ...(body.host_logo_url !== undefined ? { hostLogoUrl: body.host_logo_url } : {}),
      ...(body.host_api_key !== undefined ? { hostApiKey: body.host_api_key } : {}),
      ...(body.ramp_asset_key !== undefined ? { rampAssetKey: body.ramp_asset_key } : {}),
      ...(body.taxa_token_por_fiat_base_units !== undefined
        ? { taxaTokenPorFiatBaseUnits: body.taxa_token_por_fiat_base_units }
        : {}),
    });
    if (!profile) return { data: null };
    return { data: rampProfileDto(profile) };
  });

  app.get('/admin/api/links', async (request) => {
    const limit = limitSchema.parse((request.query as { limit?: string }).limit ?? 50);
    const links = await motor.links.list(limit);
    return {
      data: links.map((link) => linkDto(link, motor.links.pageUrl(link.pageToken))),
    };
  });

  app.get<{ Params: { id: string } }>('/admin/api/links/:id', async (request) => {
    const detail = await motor.links.detail(request.params.id);
    if (!detail) return { data: null };
    return {
      data: {
        link: linkDto(detail.link, motor.links.pageUrl(detail.link.pageToken)),
        payments: detail.payments.map(paymentDto),
        transfers: detail.transfers.map(transferDto),
        webhooks: detail.webhooks.map(webhookDto),
      },
    };
  });

  app.post<{ Params: { id: string } }>('/admin/api/links/:id/revoke', async (request) => {
    const link = await motor.links.revoke(request.params.id, 'admin', request.ip);
    return { data: linkDto(link, motor.links.pageUrl(link.pageToken)) };
  });

  app.get('/admin/api/webhooks', async (request) => {
    const limit = limitSchema.parse((request.query as { limit?: string }).limit ?? 50);
    const events = await motor.repos.webhooks.listAll(limit);
    return { data: events.map(webhookDto) };
  });

  app.post<{ Params: { id: string } }>('/admin/api/webhooks/:id/replay', async (request) => {
    const event = await motor.webhooks.replay(request.params.id);
    if (!event) return { data: null };
    return { data: webhookDto(event) };
  });

  app.post<{ Params: { id: string } }>('/admin/api/sweeps/:id/submit', async (request) => {
    const body = z.object({ raw_transaction: z.string().min(1) }).strict().parse(request.body ?? {});
    try {
      const result = await motor.sweeper.submitSignedTransfer(
        request.params.id,
        body.raw_transaction,
      );
      return { data: result };
    } catch (err) {
      if (err instanceof TransferSubmissionError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }
  });

  app.get('/admin/api/audit', async (request) => {
    const limit = limitSchema.parse((request.query as { limit?: string }).limit ?? 50);
    const events = await motor.repos.audit.list(limit);
    return { data: events.map(auditDto) };
  });

  app.get('/admin/api/alerts', async () => {
    const alertas = await collectAlerts({
      repos: motor.repos,
      logger,
      gasSponsorMinBalanceWei: options.gasSponsor.minBalanceWei,
      gasSponsorConfigured: options.gasSponsor.configured,
      gasSponsorBalances: options.gasSponsor.balances
        ? await options.gasSponsor.balances()
        : undefined,
    });
    return { data: alertas };
  });

  app.get('/admin/api/status', async () => {
    const [clients, profiles, links, webhooks] = await Promise.all([
      motor.repos.apiClients.list(),
      motor.repos.rampProfiles.list(),
      motor.repos.links.listAll(200),
      motor.repos.webhooks.listAll(200),
    ]);
    return {
      data: {
        clientes: clients.length,
        perfis_ramp: profiles.length,
        links_recentes: links.length,
        webhooks_recentes: webhooks.length,
        links_por_status: countBy(links, (link) => link.status),
        webhooks_por_status: countBy(webhooks, (event) => event.status),
      },
    };
  });
}

function requireApiClient(request: FastifyRequest): ApiClient {
  if (!request.apiClient) throw new ValidationError('cliente da API nao autenticado');
  return request.apiClient;
}

function headerString(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
