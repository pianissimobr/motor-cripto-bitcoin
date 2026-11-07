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
import type { MarketService } from '../services/market-service.js';
import {
  createLightningWallet,
  type LnbitsFactory,
} from '../services/merchant-lightning.js';
import type { MerchantWalletService } from '../services/merchant-wallet-service.js';
import type { MetricsService } from '../services/metrics-service.js';
import type { WalletChangeNotifier } from '../services/wallet-change-notifier.js';
import type { AuthoIssuerClient } from '../adapters/autho/client.js';
import type { PaymentIntentService } from '../services/payment-intent-service.js';
import type { PixChargeService } from '../services/pix-charge-service.js';
import type { SwapService } from '../services/swap-service.js';
import type {
  PaymentRequestRail,
  PaymentRequestService,
} from '../services/payment-request-service.js';
import type { LuniumWebhookService } from '../services/lunium-webhook-service.js';
import { LuniumError } from '../adapters/lunium/client.js';
import { GasStationError } from '../adapters/chain/gas-station.js';
import { createAdminAuth, createApiAuth, parseBearerToken } from './auth.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerPortalRoutes } from './portal-routes.js';
import { registerCheckoutRoutes } from './checkout-routes.js';
import type { AuthService } from '../services/auth-service.js';
import type { ReportService } from '../services/report-service.js';
import type { SubscriptionService } from '../services/subscription-service.js';
import type { GasStationService } from '../services/gas-station-service.js';
import type { CashOutService } from '../services/cashout-service.js';
import type { DeviceClientService } from '../services/device-client-service.js';
import type { OperationsService } from '../services/operations-service.js';
import type { FlagsService } from '../services/flags-service.js';
import type { LuniumClient } from '../adapters/lunium/client.js';
import { registerUserRoutes } from './user-routes.js';
import { createWalletSchema } from './wallet-schema.js';

export type ApiServices = {
  config: AppConfig;
  logger: Logger;
  repos: Repositories;
  paymentIntents: PaymentIntentService;
  clients: ClientService;
  getStatus?: () => Promise<Record<string, unknown>>;
  auth?: AuthService;
  fx?: FxService;
  market?: MarketService;
  wallets?: MerchantWalletService;
  ledger?: LedgerService;
  lnbitsFor?: LnbitsFactory;
  walletNotifier?: WalletChangeNotifier;
  autho?: AuthoIssuerClient;
  pixCharges?: PixChargeService;
  swap?: SwapService;
  paymentRequests?: PaymentRequestService;
  cashOut?: CashOutService;
  luniumWebhook?: LuniumWebhookService;
  metrics?: MetricsService;
  gasStation?: GasStationService;
  reports?: ReportService;
  subscriptions?: SubscriptionService;
  deviceClients?: DeviceClientService;
  operations?: OperationsService;
  flags?: FlagsService;
  lunium?: LuniumClient;
};

/**
 * Endereco de origem do cash-out.
 *
 * O canonico e o `settlement_address` do cliente (D18): e ele que recebe o
 * USDC do cash-in e de onde o USDC sai no cash-out, e e por ele que o
 * extrato agrega. enquanto o cliente nao tem um cadastrado, o app pode
 * informa-lo no corpo.
 */
async function resolveOriginAddress(
  services: ApiServices,
  clientId: string,
  fromBody?: string,
): Promise<string> {
  const client = await services.repos.findClientById(clientId);
  const registered = client?.settlementAddress ?? null;
  if (registered) return registered.toLowerCase();
  if (fromBody) return fromBody.toLowerCase();
  throw new ValidationError(
    'cliente sem endereco de liquidacao: registre o settlement_address ou informe origin_address',
  );
}

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
        chain: z.enum(['base', 'polygon']),
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

/**
 * Pedido de pagamento em Bitcoin que vira dolar digital.
 *
 * O valor vem sempre em centavos (`amount_cents`, D23): `amount` diverge por
 * 100x entre o app (centavos) e o motor (reais), e nome ambiguo entre dois
 * lados e bug esperando.
 */
/**
 * Pedido de pagamento com mais de um trilho.
 *
 * O valor vem sempre em centavos (`amount_cents`, D23).
 */
const createPaymentRequestSchema = z
  .object({
    external_id: z.string().trim().min(1).max(128),
    amount_cents: z
      .union([z.string().regex(/^\d+$/), z.number().int().positive()])
      .transform((value) => BigInt(value)),
    currency: z.enum(['BRL', 'USD']).default('BRL'),
    /** Trilhos oferecidos. Sem esse campo: Pix + Bitcoin. */
    rails: z
      .array(z.enum(['pix', 'bitcoin', 'pix_direto']))
      .max(3)
      .optional(),
    /** CPF/CNPJ do pagador: obrigatorio no trilho Pix. */
    payer_tax_number: z.string().trim().min(1).max(32).optional(),
    payer_name: z.string().trim().max(200).optional(),
    description: z.string().trim().max(200).optional(),
    expires_in_seconds: z.number().int().min(30).max(86_400).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const createSwapChargeSchema = z
  .object({
    external_id: z.string().trim().min(1).max(128),
    amount_cents: z.string().regex(/^\d+$/, 'amount_cents invalido'),
    currency: z.enum(['BRL', 'USD']).default('BRL'),
    /** Endereco que recebe o USDC (o padrao e o do cliente). */
    destination_address: z
      .string()
      .trim()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido')
      .optional(),
    description: z.string().trim().max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Cobranca Pix.
 *
 * O valor vem em centavos (`amount_cents`, D23). O campo `amount` (em reais)
 * continua aceito para as integracoes antigas, mas e a ultima vez: nome
 * ambiguo entre dois lados e bug esperando — o app mandava centavos no
 * `amount` e o motor lia reais, e a cobranca saia 100x maior.
 */
const createPixChargeSchema = z
  .object({
    external_id: z.string().trim().min(1).max(128),
    amount_cents: z
      .union([z.string().regex(/^\d+$/), z.number().int().positive()])
      .transform((value) => BigInt(value))
      .optional(),
    amount: fiatAmountSchema.optional(),
    currency: z.literal('BRL').default('BRL'),
    payer_tax_number: z.string().trim().min(1).max(32),
    payer_name: z.string().trim().max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    sandbox_scenario: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.amount_cents === undefined) === (value.amount === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount_cents'],
        message: 'informe amount_cents (ou amount, em reais, para as integracoes antigas)',
      });
    }
  });

/**
 * Cotacao do cash-out: `br_code` **ou** `pix_key` + valor, nunca os dois
 * (D28: o motor valida o BR Code antes de repassar).
 */
const cashOutQuoteSchema = z
  .object({
    amount_cents: z.string().regex(/^\d+$/).optional(),
    pix_key: z.string().trim().min(1).max(140).optional(),
    pix_key_type: z
      .enum(['cpf', 'cnpj', 'phone', 'email', 'random'])
      .optional(),
    br_code: z.string().trim().min(1).max(1024).optional(),
    refund_address: z
      .string()
      .trim()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido')
      .optional(),
    sandbox_scenario: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const createCashOutSchema = z
  .object({
    external_id: z.string().trim().min(1).max(64),
    /** OBRIGATORIO sem `br_code`; com `br_code`, o valor vem do codigo. */
    amount_cents: z.string().regex(/^\d+$/).optional(),
    pix_key: z.string().trim().min(1).max(140).optional(),
    pix_key_type: z
      .enum(['cpf', 'cnpj', 'phone', 'email', 'random'])
      .optional(),
    br_code: z.string().trim().min(1).max(1024).optional(),
    /**
     * Endereco de origem do USDC.
     *
     * O destino canonico e o `settlement_address` do cliente (D18); enquanto o
     * cliente nao tem um cadastrado, o app pode informa-lo.
     */
    origin_address: z
      .string()
      .trim()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido')
      .optional(),
    refund_address: z
      .string()
      .trim()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido')
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    sandbox_scenario: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const cashOutDepositSchema = z
  .object({
    tx_hash: z.string().trim().regex(/^0x[a-fA-F0-9]{64}$/, 'tx_hash invalido'),
  })
  .strict();

const cashOutRefundSchema = z
  .object({
    refund_address: z
      .string()
      .trim()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido'),
  })
  .strict();

const gasTopUpSchema = z
  .object({
    address: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido'),
    chain: z.literal('polygon').default('polygon'),
    /** Em wei do nativo. Ausente: o motor usa o valor padrao (a folga). */
    amount_wei: z.string().regex(/^\d+$/, 'amount_wei invalido').optional(),
    reason: z.string().trim().max(80).optional(),
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
  'gas:write',
  'cashout:write',
  'cashout:read',
  'operations:read',
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

const updateFlagsSchema = z
  .object({
    cash_out_enabled: z.boolean().optional(),
    cash_in_enabled: z.boolean().optional(),
    min_cash_out_brl: z.number().min(0).optional(),
    max_cash_out_brl: z.number().min(0).optional(),
    default_asset: z.enum(['USDC']).optional(),
    default_chain: z.enum(['polygon']).optional(),
    max_amount_usd_per_operation: z.number().min(0).optional(),
  })
  .strict();

/**
 * Checkout PIX publico (C9).
 *
 * A loja cria a cobranca e publica o link `/pay/{id}`: o pagador paga o Pix
 * e o USDC vai para o endereco do cliente (que a loja cadastrou com prova de
 * posse, F4) ou para a carteira da propria loja.
 */
const createPixCheckoutSchema = z
  .object({
    external_id: z.string().trim().min(1).max(64),
    amount_cents: z.string().regex(/^\d+$/),
    payer_tax_number: z.string().trim().min(11).max(18),
    payer_name: z.string().trim().max(120).optional(),
    destination_address: z
      .string()
      .trim()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido')
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

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
    purpose: wallet.purpose,
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

  registerCheckoutRoutes(app, {
    paymentIntents: services.paymentIntents,
    ...(services.pixCharges ? { pixCharges: services.pixCharges } : {}),
  });
  registerUserRoutes(app, services);

  if (services.auth) {
    registerAuthRoutes(app, {
      config: services.config,
      logger: services.logger,
      auth: services.auth,
      ...(services.autho ? { autho: services.autho } : {}),
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
        ...(services.fx ? { fx: services.fx } : {}),
        ...(services.market ? { market: services.market } : {}),
        ...(services.pixCharges ? { pixCharges: services.pixCharges } : {}),
        ...(services.deviceClients ? { possession: services.deviceClients } : {}),
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
    '/v1/user/gas/topup',
    { preHandler: apiAuth('gas:write') },
    async (request, reply) => {
      if (!services.gasStation) {
        throw new ServiceUnavailableError('gas station indisponivel');
      }
      const body = parse(gasTopUpSchema, request.body ?? {}, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.gasStation.isEnabled()) {
        throw new ServiceUnavailableError('gas station desabilitada');
      }
      const amountWei = body.amount_wei
        ? BigInt(body.amount_wei)
        : services.config.gasStation.maxTopUpWei;
      try {
        const result = await services.gasStation.topUp({
          clientId: client.id,
          address: body.address,
          chain: body.chain,
          amountWei,
          ...(body.reason ? { reason: body.reason } : {}),
        });
        return reply.status(201).send({
          amount_wei: result.amountWei.toString(),
          tx_hash: result.hash,
          chain: body.chain,
        });
      } catch (err) {
        if (err instanceof GasStationError) {
          throw new ServiceUnavailableError(
            `gas station: ${err.message} (${err.code})`,
          );
        }
        throw err;
      }
    },
  );

  /* ------------------------------------------------------------------ */
  /* Cash-out: venda de cripto por Pix (o app assina, o motor orquestra)  */
  /* ------------------------------------------------------------------ */

  app.post(
    '/v1/user/cash-out-charges/quote',
    { preHandler: apiAuth('cashout:read') },
    async (request) => {
      if (!services.cashOut) {
        throw new ServiceUnavailableError('cash-out indisponivel');
      }
      const body = parse(cashOutQuoteSchema, request.body ?? {}, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.cashOut.quote({
        ...(body.amount_cents != null
          ? { amountBrlCents: BigInt(body.amount_cents) }
          : {}),
        ...(body.pix_key ? { pixKey: body.pix_key } : {}),
        ...(body.pix_key_type ? { pixKeyType: body.pix_key_type } : {}),
        ...(body.br_code ? { brCode: body.br_code } : {}),
        ...(body.refund_address ? { refundAddress: body.refund_address } : {}),
        ...(body.sandbox_scenario
          ? { sandboxScenario: body.sandbox_scenario }
          : {}),
      });
    },
  );

  app.post(
    '/v1/user/cash-out-charges',
    { preHandler: apiAuth('cashout:write') },
    async (request, reply) => {
      if (!services.cashOut) {
        throw new ServiceUnavailableError('cash-out indisponivel');
      }
      const body = parse(createCashOutSchema, request.body ?? {}, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const originAddress = await resolveOriginAddress(
        services,
        client.id,
        body.origin_address,
      );
      const { dto, reused } = await services.cashOut.create({
        clientId: client.id,
        externalId: body.external_id,
        ...(body.amount_cents ? { amountBrlCents: BigInt(body.amount_cents) } : {}),
        originAddress,
        ...(body.pix_key ? { pixKey: body.pix_key } : {}),
        ...(body.pix_key_type ? { pixKeyType: body.pix_key_type } : {}),
        ...(body.br_code ? { brCode: body.br_code } : {}),
        ...(body.refund_address ? { refundAddress: body.refund_address } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
        ...(body.sandbox_scenario
          ? { sandboxScenario: body.sandbox_scenario }
          : {}),
      });
      return reply.status(reused ? 200 : 201).send(dto);
    },
  );

  app.get(
    '/v1/user/cash-out-charges/:id',
    { preHandler: apiAuth('cashout:read') },
    async (request) => {
      if (!services.cashOut) {
        throw new ServiceUnavailableError('cash-out indisponivel');
      }
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.cashOut.sync(params.id, client.id);
    },
  );

  app.post(
    '/v1/user/cash-out-charges/:id/accept',
    { preHandler: apiAuth('cashout:write') },
    async (request) => {
      if (!services.cashOut) {
        throw new ServiceUnavailableError('cash-out indisponivel');
      }
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.cashOut.accept(params.id, client.id);
    },
  );

  app.post(
    '/v1/user/cash-out-charges/:id/deposit',
    { preHandler: apiAuth('cashout:write') },
    async (request, reply) => {
      if (!services.cashOut) {
        throw new ServiceUnavailableError('cash-out indisponivel');
      }
      const params = parse(idParamsSchema, request.params, 'id');
      const body = parse(cashOutDepositSchema, request.body ?? {}, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      await services.cashOut.reportDeposit(params.id, client.id, body.tx_hash);
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/user/cash-out-charges/:id/refund-address',
    { preHandler: apiAuth('cashout:write') },
    async (request) => {
      if (!services.cashOut) {
        throw new ServiceUnavailableError('cash-out indisponivel');
      }
      const params = parse(idParamsSchema, request.params, 'id');
      const body = parse(cashOutRefundSchema, request.body ?? {}, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.cashOut.setRefundAddress(
        params.id,
        client.id,
        body.refund_address,
      );
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
          amountBrlCents: body.amount_cents ?? body.amount!,
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

  app.post(
    '/v1/payment-requests',
    { preHandler: apiAuth('payments:write') },
    async (request, reply) => {
      const body = parse(createPaymentRequestSchema, request.body, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.paymentRequests) {
        throw new ServiceUnavailableError('pedidos de pagamento indisponiveis');
      }
      const created = await services.paymentRequests.create({
        clientId: client.id,
        externalId: body.external_id,
        amountFiatCents: body.amount_cents,
        currency: body.currency,
        ...(body.rails ? { rails: body.rails as PaymentRequestRail[] } : {}),
        ...(body.payer_tax_number ? { payerTaxNumber: body.payer_tax_number } : {}),
        ...(body.payer_name ? { payerName: body.payer_name } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.expires_in_seconds
          ? { expiresInSeconds: body.expires_in_seconds }
          : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });
      return reply.status(created.reused ? 200 : 201).send(created.dto);
    },
  );

  app.get(
    '/v1/payment-requests/:id',
    { preHandler: apiAuth('payments:read') },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.paymentRequests) {
        throw new ServiceUnavailableError('pedidos de pagamento indisponiveis');
      }
      const found = await services.paymentRequests.get(params.id, client.id);
      if (!found) throw new NotFoundError('pedido de pagamento nao encontrado');
      return found;
    },
  );

  app.post(
    '/v1/swap-charges',
    { preHandler: apiAuth('payments:write') },
    async (request, reply) => {
      const body = parse(createSwapChargeSchema, request.body, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.swap) {
        throw new ServiceUnavailableError('swap indisponivel');
      }
      const created = await services.swap.create({
        clientId: client.id,
        externalId: body.external_id,
        amountFiatCents: BigInt(body.amount_cents),
        currency: body.currency,
        ...(body.destination_address
          ? { destinationAddress: body.destination_address }
          : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });
      return reply.status(created.reused ? 200 : 201).send(created.dto);
    },
  );

  app.get(
    '/v1/swap-charges/:id',
    { preHandler: apiAuth('payments:read') },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      if (!services.swap) {
        throw new ServiceUnavailableError('swap indisponivel');
      }
      const found = await services.swap.get(params.id, client.id);
      if (!found) throw new NotFoundError('pedido de swap nao encontrado');
      return found;
    },
  );

  app.post(
    '/v1/checkout/pix',
    { preHandler: apiAuth('payments:write') },
    async (request, reply) => {
      if (!services.pixCharges) {
        throw new ServiceUnavailableError('PIX indisponivel');
      }
      const body = parse(createPixCheckoutSchema, request.body ?? {}, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const created = await services.pixCharges.create({
        clientId: client.id,
        externalId: body.external_id,
        amountBrlCents: BigInt(body.amount_cents),
        payerTaxNumber: body.payer_tax_number,
        ...(body.payer_name ? { payerName: body.payer_name } : {}),
        ...(body.destination_address
          ? { destinationAddress: body.destination_address }
          : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });
      return reply.status(created.reused ? 200 : 201).send({
        ...created.dto,
        checkout_url: `/pay/${created.dto.id}`,
      });
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
          services.config.pix.chain,
          body.address,
        );
        if (existing) {
          if (existing.merchantId !== client.id) {
            throw new ConflictError('endereco USDC ja pertence a outra loja');
          }
          return reply.status(200).send(serializeWallet(existing));
        }
        // Endereco de CLIENTE: a prova de posse e obrigatoria. A carteira de
        // liquidacao da propria loja nao precisa (e o endereco e dela).
        if (body.purpose === 'cliente') {
          if (!services.deviceClients) {
            throw new ValidationError(
              'cadastro de endereco de cliente indisponivel: prova de posse obrigatoria',
            );
          }
          if (!body.proof) {
            throw new ValidationError(
              'prova de posse obrigatoria para endereco de cliente',
            );
          }
          const proven = await services.deviceClients.verify({
            address: body.address,
            purpose: 'wallet_registration',
            proof: body.proof,
          });
          if (!proven) {
            throw new ValidationError(
              'prova de posse do endereco invalida: peça ao cliente para assinar o desafio',
            );
          }
        }
        const wallet = await services.wallets.createUsdcSettlement({
          merchantId: client.id,
          address: body.address,
          chain: services.config.pix.chain,
          network: services.config.pix.chain,
          purpose: body.purpose,
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
    '/admin/api/flags',
    { preHandler: adminAuth },
    async () => {
      if (!services.flags) throw new ServiceUnavailableError('flags indisponiveis');
      return services.flags.get();
    },
  );

  app.patch(
    '/admin/api/flags',
    { preHandler: adminAuth },
    async (request) => {
      if (!services.flags) throw new ServiceUnavailableError('flags indisponiveis');
      const body = parse(updateFlagsSchema, request.body ?? {}, 'corpo');
      const patch: Partial<{
        cash_out_enabled: boolean;
        cash_in_enabled: boolean;
        min_cash_out_brl: number;
        max_cash_out_brl: number;
        default_asset: 'USDC';
        default_chain: 'polygon';
        max_amount_usd_per_operation: number;
      }> = {};
      if (body.cash_out_enabled !== undefined) {
        patch.cash_out_enabled = body.cash_out_enabled;
      }
      if (body.cash_in_enabled !== undefined) {
        patch.cash_in_enabled = body.cash_in_enabled;
      }
      if (body.min_cash_out_brl !== undefined) {
        patch.min_cash_out_brl = body.min_cash_out_brl;
      }
      if (body.max_cash_out_brl !== undefined) {
        patch.max_cash_out_brl = body.max_cash_out_brl;
      }
      if (body.default_asset !== undefined) patch.default_asset = body.default_asset;
      if (body.default_chain !== undefined) patch.default_chain = body.default_chain;
      if (body.max_amount_usd_per_operation !== undefined) {
        patch.max_amount_usd_per_operation = body.max_amount_usd_per_operation;
      }
      return services.flags.set(patch);
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
