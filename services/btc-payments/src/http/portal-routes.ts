import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors.js';
import type { MerchantWallet } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { AuthService } from '../services/auth-service.js';
import type { ClientService } from '../services/client-service.js';
import type { MerchantWalletService } from '../services/merchant-wallet-service.js';
import type { WalletChangeNotifier } from '../services/wallet-change-notifier.js';
import {
  createLightningWallet,
  type LnbitsFactory,
} from '../services/merchant-lightning.js';
import type { PaymentIntentService } from '../services/payment-intent-service.js';
import type { ReportService } from '../services/report-service.js';
import type { SubscriptionService } from '../services/subscription-service.js';
import type { FxService } from '../services/fx-service.js';
import type { MarketService } from '../services/market-service.js';
import { SESSION_COOKIE, csrfHeaderOf, sessionTokenOf } from './auth-routes.js';

export type PortalRoutesDeps = {
  config: AppConfig;
  logger: Logger;
  auth: AuthService;
  repos: Repositories;
  clients: ClientService;
  wallets: MerchantWalletService;
  paymentIntents: PaymentIntentService;
  reports?: ReportService;
  subscriptions?: SubscriptionService;
  lnbitsFor?: LnbitsFactory;
  walletNotifier?: WalletChangeNotifier;
  /** Cotacao BTC em R$/US$ para cobrar em moeda local. */
  fx?: FxService;
  /** Precos de mercado so para o grafico do portal. */
  market?: MarketService;
};

const createMerchantSchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();

const updateMerchantSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    webhook_url: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'informe ao menos um campo');

const createWalletSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('btc_deposit'),
      xpub: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('usdc_settlement'),
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('lightning_lnbits'),
      lnbits_url: z.string().trim().min(1).max(300),
      invoice_key: z.string().trim().min(8).max(200),
    })
    .strict(),
]);

const checkoutSchema = z
  .object({
    external_id: z.string().trim().min(1).max(128).optional(),
    amount_sats: z
      .union([z.string().regex(/^\d+$/), z.number().int().positive()])
      .optional(),
    /** Valor em centavos de `currency` (R$ ou US$); o motor converte em sats. */
    amount: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
    currency: z.enum(['BRL', 'USD']).optional(),
    description: z.string().trim().max(200).optional(),
    expires_in_seconds: z.number().int().min(30).max(86_400).optional(),
    settlement_wallet_id: z.string().uuid().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const idParamsSchema = z.object({ id: z.string().uuid() });
const walletParamsSchema = z.object({
  id: z.string().uuid(),
  walletId: z.string().uuid(),
});
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const reportQuerySchema = z.object({
  period: z.enum(['7d', '30d', 'all']).default('30d'),
});

const createSubscriptionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    amount_sats: z
      .union([z.string().regex(/^\d+$/), z.number().int().positive()]),
    description: z.string().trim().max(200).optional(),
    interval: z.enum(['day', 'week', 'month']),
    external_id: z.string().trim().min(1).max(128).optional(),
    start_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const updateSubscriptionSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    amount_sats: z
      .union([z.string().regex(/^\d+$/), z.number().int().positive()])
      .optional(),
    description: z.string().trim().max(200).nullish(),
    interval: z.enum(['day', 'week', 'month']).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'informe ao menos um campo');

const subIdParamsSchema = z.object({ id: z.string().uuid(), subId: z.string().uuid() });

function sinceFor(period: string, now = new Date()): Date {
  if (period === 'all') return new Date(0);
  const days = period === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(`${what} invalido`, result.error.issues);
  return result.data;
}

function serializeWallet(wallet: MerchantWallet): Record<string, unknown> {
  return {
    id: wallet.id,
    kind: wallet.kind,
    chain: wallet.chain,
    network: wallet.network,
    address: wallet.address,
    xpub: wallet.xpub,
    derivation_prefix: wallet.derivationPrefix,
    lnbits_url: wallet.lnbitsUrl,
    status: wallet.status,
    created_at: wallet.createdAt.toISOString(),
    updated_at: wallet.updatedAt.toISOString(),
  };
}

function serializeSubscription(sub: import('../domain/types.js').Subscription): Record<string, unknown> {
  return {
    id: sub.id,
    name: sub.name,
    amount_sats: sub.amountSats.toString(),
    description: sub.description,
    interval: sub.interval,
    status: sub.status,
    external_id: sub.externalId,
    next_charge_at: sub.nextChargeAt.toISOString(),
    created_at: sub.createdAt.toISOString(),
    updated_at: sub.updatedAt.toISOString(),
  };
}

function serializeCharge(charge: import('../domain/types.js').SubscriptionCharge): Record<string, unknown> {
  return {
    id: charge.id,
    intent_id: charge.intentId,
    period_start: charge.periodStart.toISOString(),
    period_end: charge.periodEnd.toISOString(),
    status: charge.status,
    attempted_at: charge.attemptedAt.toISOString(),
    created_at: charge.createdAt.toISOString(),
  };
}

export function registerPortalRoutes(
  app: FastifyInstance,
  deps: PortalRoutesDeps,
): void {
  async function userIdOrThrow(request: FastifyRequest): Promise<string> {
    const sessionToken = sessionTokenOf(request);
    if (!sessionToken) throw new UnauthorizedError('sessao ausente');
    return (await deps.auth.getSessionUser(sessionToken)).userId;
  }

  async function memberOrThrow(
    request: FastifyRequest,
    merchantId: string,
    mutate: boolean,
  ): Promise<string> {
    const sessionToken = sessionTokenOf(request);
    if (!sessionToken) throw new UnauthorizedError('sessao ausente');
    const { userId } = mutate
      ? await deps.auth.assertCsrf(sessionToken, csrfHeaderOf(request))
      : await deps.auth.getSessionUser(sessionToken);
    const membership = await deps.repos.findMerchantMember(userId, merchantId);
    if (!membership) throw new ForbiddenError('voce nao pertence a esta loja');
    return userId;
  }

  app.get('/v1/portal/merchants', async (request) => {
    const userId = await userIdOrThrow(request);
    const rows = await deps.repos.listMerchantsForUser(userId);
    return {
      data: rows.map(({ member, client }) => ({
        id: client.id,
        name: client.name,
        role: member.role,
        status: client.status,
        verification_status: client.verificationStatus,
        api_key_prefix: client.apiKeyPrefix,
        webhook_url: client.webhookUrl,
        base_currency: client.baseCurrency,
        created_at: client.createdAt.toISOString(),
      })),
    };
  });

  app.post('/v1/portal/merchants', async (request, reply) => {
    const sessionToken = sessionTokenOf(request);
    if (!sessionToken) throw new UnauthorizedError('sessao ausente');
    const { userId } = await deps.auth.assertCsrf(sessionToken, csrfHeaderOf(request));
    const body = parse(createMerchantSchema, request.body ?? {}, 'corpo');
    const merchant = await deps.clients.createMerchant({ name: body.name });
    await deps.repos.createMerchantMember({
      userId,
      merchantId: merchant.id,
      role: 'owner',
    });
    return reply.status(201).send({
      id: merchant.id,
      name: merchant.name,
      api_key: merchant.apiKey,
      request_secret: merchant.requestSecret,
      webhook_secret: merchant.webhookSecret,
    });
  });

  app.get('/v1/portal/merchants/:id', async (request) => {
    const { id } = parse(idParamsSchema, request.params, 'params');
    await memberOrThrow(request, id, false);
    const client = await deps.repos.findClientById(id);
    if (!client) throw new NotFoundError('loja nao encontrada');
    return {
      id: client.id,
      name: client.name,
      status: client.status,
      verification_status: client.verificationStatus,
      api_key_prefix: client.apiKeyPrefix,
      webhook_url: client.webhookUrl,
      base_currency: client.baseCurrency,
      spread_bps: client.spreadBps,
      created_at: client.createdAt.toISOString(),
    };
  });

  app.patch('/v1/portal/merchants/:id', async (request) => {
    const { id } = parse(idParamsSchema, request.params, 'params');
    await memberOrThrow(request, id, true);
    const body = parse(updateMerchantSchema, request.body ?? {}, 'corpo');
    return deps.clients.setProfile(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.webhook_url !== undefined ? { webhookUrl: body.webhook_url } : {}),
    });
  });

  app.get('/v1/portal/merchants/:id/wallets', async (request) => {
    const { id } = parse(idParamsSchema, request.params, 'params');
    await memberOrThrow(request, id, false);
    const wallets = await deps.wallets.listByMerchant(id);
    return { data: wallets.map(serializeWallet) };
  });

  app.post('/v1/portal/merchants/:id/wallets', async (request, reply) => {
    const { id } = parse(idParamsSchema, request.params, 'params');
    const userId = await memberOrThrow(request, id, true);
    const body = parse(createWalletSchema, request.body ?? {}, 'corpo');
    if (body.kind === 'usdc_settlement') {
      const existing = await deps.repos.findMerchantWalletByChainAddress(
        deps.config.pix.chain,
        body.address,
      );
      if (existing) {
        if (existing.merchantId !== id) {
          throw new ConflictError('endereco USDC ja pertence a outra loja');
        }
        return reply.status(200).send(serializeWallet(existing));
      }
      const wallet = await deps.wallets.createUsdcSettlement({
        merchantId: id,
        address: body.address,
        chain: deps.config.pix.chain,
        network: deps.config.pix.chain,
      });
      const created = await deps.repos.findMerchantWalletById(wallet.id);
      if (!created) throw new NotFoundError('carteira nao encontrada');
      await deps.walletNotifier?.notify({ merchantId: id, wallet: created, action: 'cadastrada', actor: `portal:${userId}` });
      return reply.status(201).send(serializeWallet(created));
    }
    if (body.kind === 'lightning_lnbits') {
      const created = await createLightningWallet(deps, id, body);
      await deps.walletNotifier?.notify({ merchantId: id, wallet: created, action: 'cadastrada', actor: `portal:${userId}` });
      return reply.status(201).send(serializeWallet(created));
    }
    const wallet = await deps.wallets.createBtcDeposit({
      merchantId: id,
      xpub: body.xpub,
      derivationPrefix: deps.config.btc.derivationPrefix,
      network: deps.config.btc.network,
      gapLimit: deps.config.btc.gapLimit,
    });
    const btcWallet = await deps.repos.findMerchantWalletById(wallet.id);
    if (btcWallet) {
      await deps.walletNotifier?.notify({ merchantId: id, wallet: btcWallet, action: 'cadastrada', actor: `portal:${userId}` });
    }
    return reply.status(201).send({
      id: wallet.id,
      kind: 'btc_deposit',
      chain: 'bitcoin',
      network: deps.config.btc.network,
      address: body.xpub,
      status: 'ativo',
    });
  });

  app.delete('/v1/portal/merchants/:id/wallets/:walletId', async (request) => {
    const { id, walletId } = parse(walletParamsSchema, request.params, 'params');
    const userId = await memberOrThrow(request, id, true);
    const wallet = await deps.repos.findMerchantWalletById(walletId);
    if (!wallet || wallet.merchantId !== id) {
      throw new NotFoundError('carteira nao encontrada');
    }
    await deps.repos.deactivateMerchantWallet(walletId);
    await deps.walletNotifier?.notify({ merchantId: id, wallet, action: 'removida', actor: `portal:${userId}` });
    return { ok: true };
  });

  // Gera as tres credenciais da loja (API key, request secret, webhook
  // secret) e as mostra uma unica vez. As anteriores deixam de valer.
  app.post('/v1/portal/merchants/:id/credentials', async (request) => {
    const { id } = parse(idParamsSchema, request.params, 'params');
    const userId = await memberOrThrow(request, id, true);
    const created = await deps.clients.rotateCredentials(id, `portal:${userId}`);
    return {
      api_key: created.apiKey,
      request_secret: created.requestSecret,
      webhook_secret: created.webhookSecret,
    };
  });

  app.post('/v1/portal/merchants/:id/api-key/rotate', async (request) => {
    const { id } = parse(idParamsSchema, request.params, 'params');
    await memberOrThrow(request, id, true);
    return deps.clients.rotateApiKey(id, 'portal');
  });

  // Cotacao do BTC (R$ e US$) para o formulario de checkout. Cache curto
  // para nao bater na fonte a cada tecla.
  let ratesCache: { at: number; body: Record<string, unknown> } | null = null;
  app.get('/v1/portal/fx/rates', async (request) => {
    await userIdOrThrow(request);
    if (!deps.fx) {
      throw new AppError('cotacao indisponivel', {
        code: 'fx_unavailable',
        statusCode: 503,
        expose: true,
      });
    }
    if (ratesCache && Date.now() - ratesCache.at < 30_000) return ratesCache.body;
    const rates = await deps.fx.getRates();
    const body = {
      rates: rates.map((rate) => ({
        currency: rate.currency,
        btc_price_cents: rate.btcPriceCents.toString(),
        source: rate.source,
        observed_at: rate.observedAt.toISOString(),
      })),
    };
    ratesCache = { at: Date.now(), body };
    return body;
  });

  // Precos de mercado (grafico decorativo do dashboard).
  app.get('/v1/portal/market', async (request, reply) => {
    await userIdOrThrow(request);
    const snapshot = deps.market ? await deps.market.snapshot() : null;
    if (!snapshot) {
      return reply.status(503).send({
        error: { code: 'market_unavailable', message: 'mercado indisponivel' },
      });
    }
    return snapshot;
  });

  app.post('/v1/portal/merchants/:id/checkout', async (request, reply) => {
    const { id } = parse(idParamsSchema, request.params, 'params');
    await memberOrThrow(request, id, true);
    const body = parse(checkoutSchema, request.body ?? {}, 'corpo');
    let amountSats: bigint;
    let fiat: { currency: 'BRL' | 'USD'; amountFiat: bigint; fxQuoteId: string } | null = null;
    if (body.amount !== undefined) {
      if (!body.currency) throw new ValidationError('currency obrigatorio com amount');
      if (body.amount_sats !== undefined) {
        throw new ValidationError('informe amount ou amount_sats, nao os dois');
      }
      if (!deps.fx) {
        throw new AppError('cotacao indisponivel', {
          code: 'fx_unavailable',
          statusCode: 503,
          expose: true,
        });
      }
      // Sem conversao: o lojista recebe BTC; a cotacao so traduz o preco, sem margem.
      const quote = await deps.fx.createQuote({
        merchantId: id,
        amountFiatCents: BigInt(body.amount),
        currency: body.currency,
        spreadBps: 0,
        ttlSeconds: deps.config.fx.quoteTtlSeconds,
      });
      amountSats = quote.amountOut;
      fiat = { currency: body.currency, amountFiat: quote.amountIn, fxQuoteId: quote.id };
    } else if (body.amount_sats !== undefined) {
      amountSats = BigInt(body.amount_sats);
    } else {
      throw new ValidationError('informe o valor (amount + currency ou amount_sats)');
    }
    const created = await deps.paymentIntents.create({
      clientId: id,
      externalId:
        body.external_id ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      amountSats,
      description: body.description ?? null,
      metadata: body.metadata ?? null,
      ...(fiat
        ? { currency: fiat.currency, amountFiat: fiat.amountFiat, fxQuoteId: fiat.fxQuoteId }
        : {}),
      ...(body.expires_in_seconds !== undefined
        ? { expiresInSeconds: body.expires_in_seconds }
        : {}),
      ...(body.settlement_wallet_id
        ? { walletId: body.settlement_wallet_id }
        : {}),
    });
    return reply.status(created.reused ? 200 : 201).send(created.dto);
  });

  app.get('/v1/portal/merchants/:id/intents', async (request) => {
    const { id } = parse(idParamsSchema, request.params, 'params');
    await memberOrThrow(request, id, false);
    const query = parse(listQuerySchema, request.query ?? {}, 'query');
    const intents = await deps.repos.listIntentsForClient(id, query.limit);
    return {
      data: intents.map((intent) => ({
        id: intent.id,
        external_id: intent.externalId,
        status: intent.status,
        amount_sats: intent.amountSats.toString(),
        currency: intent.currency,
        paid_rail: intent.paidRail,
        paid_amount_sats: intent.paidAmountSats?.toString() ?? null,
        settlement_status: intent.settlementStatus,
        paid_at: intent.paidAt?.toISOString() ?? null,
        created_at: intent.createdAt.toISOString(),
      })),
    };
  });

  app.get('/v1/portal/merchants/:id/intents/:intentId', async (request) => {
    const { id, intentId } = parse(
      z.object({ id: z.string().uuid(), intentId: z.string().uuid() }),
      request.params,
      'params',
    );
    await memberOrThrow(request, id, false);
    const intent = await deps.repos.findIntentByIdForClient(intentId, id);
    if (!intent) throw new NotFoundError('cobranca nao encontrada');
    return deps.paymentIntents.toDto(intent);
  });

  if (deps.reports) {
    const reports = deps.reports;

    app.get('/v1/portal/merchants/:id/reports/summary', async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, false);
      const query = parse(reportQuerySchema, request.query ?? {}, 'query');
      return { period: query.period, ...(await reports.summary(id, sinceFor(query.period))) };
    });

    app.get('/v1/portal/merchants/:id/reports/by-rail', async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, false);
      const query = parse(reportQuerySchema, request.query ?? {}, 'query');
      return { data: await reports.byRail(id, sinceFor(query.period)) };
    });

    app.get('/v1/portal/merchants/:id/reports/series', async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, false);
      const query = parse(reportQuerySchema, request.query ?? {}, 'query');
      return { data: await reports.series(id, sinceFor(query.period)) };
    });
  }

  if (deps.subscriptions) {
    const subscriptions = deps.subscriptions;

    app.post('/v1/portal/merchants/:id/subscriptions', async (request, reply) => {
      const { id } = parse(idParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, true);
      const body = parse(createSubscriptionSchema, request.body ?? {}, 'corpo');
      const amountSats =
        typeof body.amount_sats === 'number'
          ? BigInt(body.amount_sats)
          : BigInt(body.amount_sats);
      const subscription = await subscriptions.create({
        merchantId: id,
        name: body.name,
        amountSats,
        description: body.description ?? null,
        interval: body.interval,
        externalId: body.external_id ?? null,
        ...(body.start_at ? { startAt: new Date(body.start_at) } : {}),
      });
      return reply.status(201).send(serializeSubscription(subscription));
    });

    app.get('/v1/portal/merchants/:id/subscriptions', async (request) => {
      const { id } = parse(idParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, false);
      const query = parse(listQuerySchema, request.query ?? {}, 'query');
      const rows = await deps.repos.listSubscriptionsForClient(id, query.limit);
      return { data: rows.map(serializeSubscription) };
    });

    app.get('/v1/portal/merchants/:id/subscriptions/:subId', async (request) => {
      const { id, subId } = parse(subIdParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, false);
      const subscription = await deps.repos.findSubscriptionByIdForClient(subId, id);
      if (!subscription) throw new NotFoundError('assinatura nao encontrada');
      return serializeSubscription(subscription);
    });

    app.patch('/v1/portal/merchants/:id/subscriptions/:subId', async (request) => {
      const { id, subId } = parse(subIdParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, true);
      const body = parse(updateSubscriptionSchema, request.body ?? {}, 'corpo');
      const current = await deps.repos.findSubscriptionByIdForClient(subId, id);
      if (!current) throw new NotFoundError('assinatura nao encontrada');
      const amountSats = body.amount_sats !== undefined
        ? (typeof body.amount_sats === 'number' ? BigInt(body.amount_sats) : BigInt(body.amount_sats))
        : undefined;
      const updated = await deps.repos.updateSubscription(subId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(amountSats !== undefined ? { amountSats } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.interval !== undefined ? { interval: body.interval } : {}),
      });
      return serializeSubscription(updated!);
    });

    app.post('/v1/portal/merchants/:id/subscriptions/:subId/pause', async (request) => {
      const { id, subId } = parse(subIdParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, true);
      const current = await deps.repos.findSubscriptionByIdForClient(subId, id);
      if (!current) throw new NotFoundError('assinatura nao encontrada');
      return serializeSubscription(await subscriptions.pause(subId));
    });

    app.post('/v1/portal/merchants/:id/subscriptions/:subId/resume', async (request) => {
      const { id, subId } = parse(subIdParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, true);
      const current = await deps.repos.findSubscriptionByIdForClient(subId, id);
      if (!current) throw new NotFoundError('assinatura nao encontrada');
      return serializeSubscription(await subscriptions.resume(subId));
    });

    app.post('/v1/portal/merchants/:id/subscriptions/:subId/cancel', async (request) => {
      const { id, subId } = parse(subIdParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, true);
      const current = await deps.repos.findSubscriptionByIdForClient(subId, id);
      if (!current) throw new NotFoundError('assinatura nao encontrada');
      return serializeSubscription(await subscriptions.cancel(subId));
    });

    app.get('/v1/portal/merchants/:id/subscriptions/:subId/charges', async (request) => {
      const { id, subId } = parse(subIdParamsSchema, request.params, 'params');
      await memberOrThrow(request, id, false);
      const current = await deps.repos.findSubscriptionByIdForClient(subId, id);
      if (!current) throw new NotFoundError('assinatura nao encontrada');
      const query = parse(listQuerySchema, request.query ?? {}, 'query');
      const charges = await deps.repos.listSubscriptionCharges(subId, query.limit);
      return { data: charges.map(serializeCharge) };
    });
  }
}