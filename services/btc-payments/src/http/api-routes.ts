import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { timingSafeEqualString } from '../crypto/hmac.js';
import type { Repositories } from '../db/repositories.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors.js';
import { lnbitsWalletWebhookToken } from '../domain/bip21.js';
import { parseFiatToCents } from '../domain/fx.js';
import { parseSats } from '../domain/money.js';
import type { ApiScope, ConversionLeg, ConversionOrder, MerchantWallet, Payout } from '../domain/types.js';
import type { LedgerService } from '../ledger/ledger-service.js';
import type { Logger } from '../logger.js';
import type { ClientService } from '../services/client-service.js';
import type { FxService } from '../services/fx-service.js';
import {
  createLightningWallet,
  type LnbitsFactory,
} from '../services/merchant-lightning.js';
import type { MerchantWalletService } from '../services/merchant-wallet-service.js';
import type { MetricsService } from '../services/metrics-service.js';
import type { WalletChangeNotifier } from '../services/wallet-change-notifier.js';
import type { PaymentIntentService } from '../services/payment-intent-service.js';
import type { PixChargeService } from '../services/pix-charge-service.js';
import type { LuniumWebhookService } from '../services/lunium-webhook-service.js';
import { LuniumError } from '../adapters/lunium/client.js';
import { createAdminAuth, createApiAuth, parseBearerToken } from './auth.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerPortalRoutes } from './portal-routes.js';
import { registerCheckoutRoutes } from './checkout-routes.js';
import type { AuthService } from '../services/auth-service.js';
import type { ReportService } from '../services/report-service.js';
import type { SubscriptionService } from '../services/subscription-service.js';

export type ApiServices = {
  config: AppConfig;
  logger: Logger;
  repos: Repositories;
  paymentIntents: PaymentIntentService;
  clients: ClientService;
  getStatus?: () => Promise<Record<string, unknown>>;
  auth?: AuthService;
  fx?: FxService;
  wallets?: MerchantWalletService;
  ledger?: LedgerService;
  lnbitsFor?: LnbitsFactory;
  walletNotifier?: WalletChangeNotifier;
  pixCharges?: PixChargeService;
  luniumWebhook?: LuniumWebhookService;
  metrics?: MetricsService;
  reports?: ReportService;
  subscriptions?: SubscriptionService;
};

const amountSatsSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().positive()])
  .transform((value) => parseSats(value));

const fiatAmountSchema = z
  .union([
    z.string().regex(/^\d+(\.\d{1,2})?$/),
    z.number().positive(),
  ])
  .transform((value) => parseFiatToCents(value));

const createIntentSchema = z
  .object({
    external_id: z.string().trim().min(1).max(128),
    amount_sats: amountSatsSchema.optional(),
    amount: fiatAmountSchema.optional(),
    currency: z.enum(['BRL', 'USD']).optional(),
    description: z.string().trim().max(200).optional(),
    expires_in_seconds: z.number().int().min(30).max(86_400).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    settlement: z
      .object({
        asset: z.literal('USDC'),
        chain: z.literal('base'),
        wallet_id: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.amount === undefined) === (value.amount_sats === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'informe amount + currency ou amount_sats, mas nao ambos',
      });
    }
    if (value.amount !== undefined && !value.currency) {
      ctx.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'currency e obrigatoria quando amount e informado',
      });
    }
  });

const createPixChargeSchema = z
  .object({
    external_id: z.string().trim().min(1).max(128),
    amount: fiatAmountSchema,
    currency: z.literal('BRL').default('BRL'),
    payer_tax_number: z.string().trim().min(1).max(32),
    payer_name: z.string().trim().max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    sandbox_scenario: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const apiScopeSchema = z.enum([
  'payments:write',
  'payments:read',
  'wallets:read',
  'wallets:write',
  'balances:read',
  'conversions:read',
  'payouts:read',
]);

const createClientSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    webhook_url: z.string().url(),
    scopes: z.array(apiScopeSchema).min(1).optional(),
  })
  .strict();

const idParamsSchema = z.object({ id: z.string().uuid() });
const externalIdQuerySchema = z.object({
  external_id: z.string().trim().min(1).max(128),
});
const webhookQuerySchema = z.object({
  token: z.string().min(1),
  w: z.string().uuid(),
});
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const createWalletSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('btc_deposit'),
      xpub: z.string().min(1),
      derivation_prefix: z
        .string()
        .regex(/^\d+(\/\d+)*$/)
        .optional(),
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

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapLuniumError(err: unknown): never {
  if (err instanceof LuniumError) {
    if (err.statusCode === 401) throw new UnauthorizedError('credencial Lunium invalida');
    if (err.statusCode === 400 || err.statusCode === 409) {
      throw new ValidationError(err.message, { request_id: err.requestId });
    }
    throw new ServiceUnavailableError(err.message, {
      request_id: err.requestId,
    });
  }
  throw err;
}

function serializeConversion(
  order: ConversionOrder,
  legs?: ConversionLeg[],
): Record<string, unknown> {
  return {
    id: order.id,
    intent_id: order.intentId,
    fx_quote_id: order.fxQuoteId,
    source_asset: order.sourceAsset,
    source_amount_sats: order.sourceAmountSats.toString(),
    target_asset: order.targetAsset,
    target_chain: order.targetChain,
    target_amount_minor: order.targetAmountMinor?.toString() ?? null,
    provider: order.provider,
    provider_order_id: order.providerOrderId,
    status: order.status,
    fee_sats: order.feeSats?.toString() ?? null,
    fee_minor: order.feeMinor?.toString() ?? null,
    txids: order.txids,
    error: order.error,
    attempts: order.attempts,
    quote_expires_at: iso(order.quoteExpiresAt),
    created_at: order.createdAt.toISOString(),
    updated_at: order.updatedAt.toISOString(),
    ...(legs
      ? {
          legs: legs.map((leg) => ({
            id: leg.id,
            leg: leg.leg,
            provider: leg.provider,
            status: leg.status,
            txid: leg.txid,
            provider_ref: leg.providerRef,
            amount_in: leg.amountIn?.toString() ?? null,
            amount_out: leg.amountOut?.toString() ?? null,
            fee_minor: leg.feeMinor?.toString() ?? null,
            created_at: leg.createdAt.toISOString(),
            updated_at: leg.updatedAt.toISOString(),
          })),
        }
      : {}),
  };
}

function serializePayout(payout: Payout): Record<string, unknown> {
  return {
    id: payout.id,
    conversion_id: payout.conversionId,
    pix_charge_id: payout.pixChargeId,
    wallet_id: payout.walletId,
    asset: payout.asset,
    chain: payout.chain,
    amount_minor: payout.amountMinor.toString(),
    fee_minor: payout.feeMinor?.toString() ?? null,
    status: payout.status,
    txid: payout.txid,
    destination_address: payout.destinationAddress,
    idempotency_key: payout.idempotencyKey,
    approved_by: payout.approvedBy,
    last_error: payout.lastError,
    created_at: payout.createdAt.toISOString(),
    sent_at: iso(payout.sentAt),
    confirmed_at: iso(payout.confirmedAt),
  };
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

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`${what} invalido`, result.error.issues);
  }
  return result.data;
}

export function registerApiRoutes(
  app: FastifyInstance,
  services: ApiServices,
): void {
  const apiAuth = (scope: ApiScope) =>
    createApiAuth(
      {
        repos: services.repos,
        config: services.config,
        logger: services.logger,
      },
      scope,
    );
  const adminAuth = createAdminAuth({
    repos: services.repos,
    config: services.config,
    logger: services.logger,
  });

  registerCheckoutRoutes(app, { paymentIntents: services.paymentIntents });

  if (services.auth) {
    registerAuthRoutes(app, {
      config: services.config,
      logger: services.logger,
      auth: services.auth,
    });
    if (services.wallets) {
      registerPortalRoutes(app, {
        config: services.config,
        logger: services.logger,
        auth: services.auth,
        repos: services.repos,
        clients: services.clients,
        wallets: services.wallets,
        paymentIntents: services.paymentIntents,
        ...(services.reports ? { reports: services.reports } : {}),
        ...(services.subscriptions ? { subscriptions: services.subscriptions } : {}),
        ...(services.lnbitsFor ? { lnbitsFor: services.lnbitsFor } : {}),
        ...(services.walletNotifier ? { walletNotifier: services.walletNotifier } : {}),
      });
    }
  }

  app.post(
    '/v1/payment-intents',
    { preHandler: apiAuth('payments:write') },
    async (request, reply) => {
      const body = parse(createIntentSchema, request.body, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');

      let amountSats = body.amount_sats;
      let currency = body.currency ?? client.baseCurrency;
      let amountFiat: bigint | null = null;
      let fxQuoteId: string | null = null;

      if (body.amount !== undefined) {
        if (!services.fx) {
          throw new AppError('cotacao indisponivel', {
            code: 'fx_unavailable',
            statusCode: 503,
            expose: true,
          });
        }
        const quote = await services.fx.createQuote({
          merchantId: client.id,
          amountFiatCents: body.amount,
          currency: body.currency!,
          spreadBps: client.spreadBps,
          ttlSeconds: services.config.fx.quoteTtlSeconds,
        });
        amountSats = quote.amountOut;
        currency = quote.baseCurrency;
        amountFiat = quote.amountIn;
        fxQuoteId = quote.id;
      }

      if (amountSats === undefined) {
        throw new ValidationError('valor da cobranca ausente');
      }

      const created = await services.paymentIntents.create({
        clientId: client.id,
        externalId: body.external_id,
        amountSats,
        description: body.description ?? null,
        metadata: body.metadata ?? null,
        ...(body.amount !== undefined ? { currency } : {}),
        ...(amountFiat !== null ? { amountFiat } : {}),
        ...(fxQuoteId ? { fxQuoteId } : {}),
        ...(body.settlement?.wallet_id ? { walletId: body.settlement.wallet_id } : {}),
        ...(body.expires_in_seconds !== undefined
          ? { expiresInSeconds: body.expires_in_seconds }
          : {}),
      });
      return reply.status(created.reused ? 200 : 201).send(created.dto);
    },
  );

  app.get(
    '/v1/payment-intents',
    { preHandler: apiAuth('payments:read') },
    async (request) => {
      const query = parse(
        externalIdQuerySchema,
        request.query,
        'query string',
      );
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.paymentIntents.getByExternalId(
        client.id,
        query.external_id,
      );
    },
  );

  app.get(
    '/v1/payment-intents/:id',
    { preHandler: apiAuth('payments:read') },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.paymentIntents.getById(client.id, params.id);
    },
  );

  app.post(
    '/v1/payment-intents/:id/cancel',
    { preHandler: apiAuth('payments:write') },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.paymentIntents.cancel(client.id, params.id);
    },
  );

  app.post(
    '/v1/pix-charges',
    { preHandler: apiAuth('payments:write') },
    async (request, reply) => {
      const body = parse(createPixChargeSchema, request.body, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.pixCharges) {
        throw new ServiceUnavailableError('PIX indisponivel');
      }
      try {
        const created = await services.pixCharges.create({
          clientId: client.id,
          externalId: body.external_id,
          amountBrlCents: body.amount,
          payerTaxNumber: body.payer_tax_number,
          ...(body.payer_name ? { payerName: body.payer_name } : {}),
          ...(body.metadata ? { metadata: body.metadata } : {}),
          ...(body.sandbox_scenario
            ? { sandboxScenario: body.sandbox_scenario }
            : {}),
        });
        return reply.status(created.reused ? 200 : 201).send(created.dto);
      } catch (err) {
        mapLuniumError(err);
      }
    },
  );

  app.get(
    '/v1/pix-charges',
    { preHandler: apiAuth('payments:read') },
    async (request) => {
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.pixCharges) {
        throw new ServiceUnavailableError('PIX indisponivel');
      }
      const query = request.query as Record<string, unknown>;
      if (typeof query.external_id === 'string' && query.external_id.length > 0) {
        return services.pixCharges.getByExternalId(client.id, query.external_id);
      }
      const parsed = parse(listQuerySchema, request.query, 'query string');
      return { data: await services.pixCharges.listForMerchant(client.id, parsed.limit) };
    },
  );

  app.get(
    '/v1/pix-charges/:id',
    { preHandler: apiAuth('payments:read') },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.pixCharges) {
        throw new ServiceUnavailableError('PIX indisponivel');
      }
      return services.pixCharges.getById(client.id, params.id);
    },
  );

  app.get(
    '/v1/balances',
    { preHandler: apiAuth('balances:read') },
    async (request) => {
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.ledger) {
        throw new ServiceUnavailableError('ledger indisponivel');
      }
      const balances = await services.ledger.getMerchantBalances(client.id);
      return {
        merchant_id: client.id,
        balances: balances.map((item) => ({
          account_code: item.accountCode,
          asset: item.asset,
          kind: item.kind,
          debit: item.debit.toString(),
          credit: item.credit.toString(),
          balance: item.balance.toString(),
        })),
      };
    },
  );

  app.get(
    '/v1/conversions',
    { preHandler: apiAuth('conversions:read') },
    async (request) => {
      const query = parse(listQuerySchema, request.query, 'query string');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const orders = await services.repos.listConversionOrdersForMerchant(
        client.id,
        query.limit,
      );
      return { data: orders.map((order) => serializeConversion(order)) };
    },
  );

  app.get(
    '/v1/conversions/:id',
    { preHandler: apiAuth('conversions:read') },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const order = await services.repos.findConversionOrderByIdForMerchant(
        params.id,
        client.id,
      );
      if (!order) throw new NotFoundError('conversao nao encontrada');
      const legs = await services.repos.listConversionLegs(order.id);
      return serializeConversion(order, legs);
    },
  );

  app.get(
    '/v1/payouts',
    { preHandler: apiAuth('payouts:read') },
    async (request) => {
      const query = parse(listQuerySchema, request.query, 'query string');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const payouts = await services.repos.listPayoutsForMerchant(
        client.id,
        query.limit,
      );
      return { data: payouts.map(serializePayout) };
    },
  );

  app.get(
    '/v1/payouts/:id',
    { preHandler: apiAuth('payouts:read') },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const payout = await services.repos.findPayoutByIdForMerchant(
        params.id,
        client.id,
      );
      if (!payout) throw new NotFoundError('payout nao encontrado');
      return serializePayout(payout);
    },
  );

  app.get(
    '/v1/wallets',
    { preHandler: apiAuth('wallets:read') },
    async (request) => {
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.wallets) {
        throw new ServiceUnavailableError('carteiras indisponiveis');
      }
      const wallets = await services.wallets.listByMerchant(client.id);
      return { data: wallets.map(serializeWallet) };
    },
  );

  app.post(
    '/v1/wallets',
    { preHandler: apiAuth('wallets:write') },
    async (request, reply) => {
      const body = parse(createWalletSchema, request.body, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.wallets) {
        throw new ServiceUnavailableError('carteiras indisponiveis');
      }
      if (body.kind === 'usdc_settlement') {
        const existing = await services.repos.findMerchantWalletByChainAddress(
          'base',
          body.address,
        );
        if (existing) {
          if (existing.merchantId !== client.id) {
            throw new ConflictError('endereco USDC ja pertence a outra loja');
          }
          return reply.status(200).send(serializeWallet(existing));
        }
        const wallet = await services.wallets.createUsdcSettlement({
          merchantId: client.id,
          address: body.address,
          chain: 'base',
          network: 'base',
        });
        const created = await services.repos.findMerchantWalletById(wallet.id);
        if (!created) throw new NotFoundError('carteira nao encontrada');
        await services.walletNotifier?.notify({ merchantId: client.id, wallet: created, action: 'cadastrada', actor: 'api' });
        return reply.status(201).send(serializeWallet(created));
      }
      if (body.kind === 'lightning_lnbits') {
        const created = await createLightningWallet(services, client.id, body);
        await services.walletNotifier?.notify({ merchantId: client.id, wallet: created, action: 'cadastrada', actor: 'api' });
        return reply.status(201).send(serializeWallet(created));
      }
      const wallet = await services.wallets.createBtcDeposit({
        merchantId: client.id,
        xpub: body.xpub,
        derivationPrefix:
          body.derivation_prefix ?? services.config.btc.derivationPrefix,
        network: services.config.btc.network,
        gapLimit: services.config.btc.gapLimit,
      });
      const btcWallet = await services.repos.findMerchantWalletById(wallet.id);
      if (btcWallet) {
        await services.walletNotifier?.notify({ merchantId: client.id, wallet: btcWallet, action: 'cadastrada', actor: 'api' });
      }
      return reply.status(201).send({
        id: wallet.id,
        kind: 'btc_deposit',
        chain: 'bitcoin',
        network: services.config.btc.network,
        address: wallet.address,
        status: 'ativo',
      });
    },
  );

  app.get(
    '/v1/fx/rates',
    { preHandler: apiAuth('payments:read') },
    async () => {
      if (!services.fx) {
        throw new ServiceUnavailableError('cotacao indisponivel');
      }
      const rates = await services.fx.getRates();
      return {
        rates: rates.map((rate) => ({
          currency: rate.currency,
          btc_price_cents: rate.btcPriceCents.toString(),
          source: rate.source,
          observed_at: rate.observedAt.toISOString(),
        })),
      };
    },
  );

  app.get('/metrics', async (request, reply) => {
    const expected = services.config.metrics.token;
    if (expected) {
      const provided = parseBearerToken(request.headers.authorization);
      if (!provided || !timingSafeEqualString(provided, expected)) {
        throw new UnauthorizedError('token de metricas invalido');
      }
    }
    if (!services.metrics) {
      throw new ServiceUnavailableError('metricas indisponiveis');
    }
    const body = await services.metrics.render();
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(body);
  });


  /**
   * Webhook de entrada do LNbits. O payload NAO e confiavel: o status e
   * sempre confirmado em GET /api/v1/payments/{payment_hash}.
   */
  app.post('/webhooks/lnbits', async (request) => {
    const token = services.config.lightning.webhookToken;
    if (!services.config.lightning.enabled || !token) {
      throw new ServiceUnavailableError('Lightning desabilitado');
    }
    const query = parse(webhookQuerySchema, request.query, 'token');
    // Cada wallet de lojista tem o proprio token (derivado do segredo do
    // servidor), e o webhook so pode conferir invoices daquela wallet.
    if (!timingSafeEqualString(query.token, lnbitsWalletWebhookToken(token, query.w))) {
      throw new UnauthorizedError('token de webhook invalido');
    }

    let raw: unknown = request.body ?? {};
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw) as unknown;
      } catch {
        throw new ValidationError('corpo do webhook do LNbits nao e JSON');
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('corpo do webhook do LNbits invalido');
    }
    const payload = raw as Record<string, unknown>;
    services.logger.debug(
      { keys: Object.keys(payload), bodyType: typeof request.body },
      'webhook do LNbits recebido',
    );
    const paymentHash =
      typeof payload.payment_hash === 'string'
        ? payload.payment_hash
        : typeof payload.checking_id === 'string'
          ? payload.checking_id
          : null;
    if (!paymentHash) {
      throw new ValidationError('payment_hash ausente no webhook do LNbits');
    }

    const result = await services.paymentIntents.applyLightningPayment(
      paymentHash,
      query.w,
    );
    services.logger.info(
      { paymentHash, status: result.status, idTransacao: result.id_transacao },
      'webhook do LNbits processado',
    );
    return result;
  });

  /**
   * Webhook de entrada da Lunium. Assinatura HMAC sobre o corpo bruto.
   */
  app.post('/webhooks/lunium', async (request, reply) => {
    if (!services.luniumWebhook) {
      throw new ServiceUnavailableError('PIX desabilitado');
    }
    const rawBody = request.rawBody;
    if (!rawBody) throw new ValidationError('corpo bruto ausente');
    const signature = request.headers['x-lunium-signature'];
    const eventId = request.headers['x-lunium-event-id'];
    try {
      return await services.luniumWebhook.receive({
        signature: typeof signature === 'string' ? signature : null,
        eventId: typeof eventId === 'string' ? eventId : null,
        rawBody,
      });
    } catch (err) {
      mapLuniumError(err);
    }
  });

  app.post(
    '/admin/api/clients',
    { preHandler: adminAuth },
    async (request, reply) => {
      const body = parse(createClientSchema, request.body, 'corpo');
      const created = await services.clients.create({
        name: body.name,
        webhookUrl: body.webhook_url,
        ...(body.scopes ? { scopes: body.scopes } : {}),
      });
      return reply.status(201).send(created);
    },
  );

  app.get(
    '/admin/api/clients',
    { preHandler: adminAuth },
    async () => services.clients.list(),
  );

  app.get(
    '/admin/api/status',
    { preHandler: adminAuth },
    async () => {
      if (!services.getStatus) return { ok: true };
      return services.getStatus();
    },
  );

  app.get(
    '/admin/api/webhooks',
    { preHandler: adminAuth },
    async (request) => {
      const query = parse(
        z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        request.query,
        'query string',
      );
      return services.repos.listWebhookEvents(query.limit);
    },
  );

  app.post(
    '/admin/api/webhooks/:id/replay',
    { preHandler: adminAuth },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const event = await services.repos.replayWebhookEvent(params.id);
      if (!event) throw new NotFoundError('webhook nao encontrado');
      services.logger.info({ eventId: event.id }, 'webhook reenfileirado');
      return event;
    },
  );

  app.get(
    '/admin/api/sweeps',
    { preHandler: adminAuth },
    async (request) => {
      const query = parse(
        z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        request.query,
        'query string',
      );
      return services.repos.listSweeps(query.limit);
    },
  );

  app.get(
    '/admin/api/merchants',
    { preHandler: adminAuth },
    async () => services.clients.list(),
  );

  app.get(
    '/admin/api/pix-charges',
    { preHandler: adminAuth },
    async (request) => {
      if (!services.pixCharges) {
        throw new ServiceUnavailableError('PIX desabilitado');
      }
      const query = parse(listQuerySchema, request.query, 'query string');
      return { data: await services.pixCharges.list(query.limit) };
    },
  );

  app.post(
    '/admin/api/pix-charges/:id/sync',
    { preHandler: adminAuth },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      if (!services.pixCharges) {
        throw new ServiceUnavailableError('PIX desabilitado');
      }
      try {
        return await services.pixCharges.sync(params.id);
      } catch (err) {
        if (err instanceof NotFoundError) throw err;
        mapLuniumError(err);
      }
    },
  );

  app.get(
    '/admin/api/conversions',
    { preHandler: adminAuth },
    async (request) => {
      const query = parse(listQuerySchema, request.query, 'query string');
      const orders = await services.repos.listConversionOrders(query.limit);
      return { data: orders.map((order) => serializeConversion(order)) };
    },
  );

  app.get(
    '/admin/api/payouts',
    { preHandler: adminAuth },
    async (request) => {
      const query = parse(listQuerySchema, request.query, 'query string');
      const payouts = await services.repos.listPayouts(query.limit);
      return { data: payouts.map(serializePayout) };
    },
  );

  app.get(
    '/admin/api/reconciliation/runs',
    { preHandler: adminAuth },
    async (request) => {
      const query = parse(listQuerySchema, request.query, 'query string');
      return { data: await services.repos.listReconciliationRuns(query.limit) };
    },
  );

  app.get(
    '/admin/api/reconciliation',
    { preHandler: adminAuth },
    async () => {
      const [counts, assetTotals] = await Promise.all([
        services.repos.getSettlementCounts(),
        services.ledger ? services.ledger.getAssetTotals() : Promise.resolve([]),
      ]);
      return {
        ok: assetTotals.every((item) => item.balanced),
        conversions: counts.conversions,
        payouts: counts.payouts,
        ledger: assetTotals.map((item) => ({
          asset: item.asset,
          debit: item.debit.toString(),
          credit: item.credit.toString(),
          balanced: item.balanced,
        })),
      };
    },
  );

}
