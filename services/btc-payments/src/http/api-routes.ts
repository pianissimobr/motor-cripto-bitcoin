import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isEsploraNotFound, type EsploraClient } from '../adapters/chain/esplora.js';
import type { AppConfig } from '../config.js';
import { timingSafeEqualString } from '../crypto/hmac.js';
import type { Repositories } from '../db/repositories.js';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors.js';
import { parseSats } from '../domain/money.js';
import type { Logger } from '../logger.js';
import type { ClientService } from '../services/client-service.js';
import type { PaymentIntentService } from '../services/payment-intent-service.js';
import { createAdminAuth, createApiAuth } from './auth.js';

export type ApiServices = {
  config: AppConfig;
  logger: Logger;
  repos: Repositories;
  paymentIntents: PaymentIntentService;
  clients: ClientService;
  getStatus?: () => Promise<Record<string, unknown>>;
  esplora?: Pick<EsploraClient, 'getTx'>;
};

const amountSatsSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().positive()])
  .transform((value) => parseSats(value));

const createIntentSchema = z
  .object({
    external_id: z.string().trim().min(1).max(128),
    amount_sats: amountSatsSchema,
    description: z.string().trim().max(200).optional(),
    expires_in_seconds: z.number().int().min(30).max(86_400).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const createClientSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    webhook_url: z.string().url(),
  })
  .strict();

const idParamsSchema = z.object({ id: z.string().uuid() });
const externalIdQuerySchema = z.object({
  external_id: z.string().trim().min(1).max(128),
});
const webhookQuerySchema = z.object({ token: z.string().min(1) });

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
  const apiAuth = createApiAuth({
    repos: services.repos,
    config: services.config,
    logger: services.logger,
  });
  const adminAuth = createAdminAuth({
    repos: services.repos,
    config: services.config,
    logger: services.logger,
  });

  app.post(
    '/v1/payment-intents',
    { preHandler: apiAuth },
    async (request, reply) => {
      const body = parse(createIntentSchema, request.body, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const created = await services.paymentIntents.create({
        clientId: client.id,
        externalId: body.external_id,
        amountSats: body.amount_sats,
        description: body.description ?? null,
        metadata: body.metadata ?? null,
        ...(body.expires_in_seconds !== undefined
          ? { expiresInSeconds: body.expires_in_seconds }
          : {}),
      });
      return reply.status(created.reused ? 200 : 201).send(created.dto);
    },
  );

  app.get(
    '/v1/payment-intents',
    { preHandler: apiAuth },
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
    { preHandler: apiAuth },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.paymentIntents.getById(client.id, params.id);
    },
  );

  app.post(
    '/v1/payment-intents/:id/cancel',
    { preHandler: apiAuth },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.paymentIntents.cancel(client.id, params.id);
    },
  );

  /**
   * Webhook de entrada do LNbits. O payload NAO e confiavel: o status e
   * sempre confirmado em GET /api/v1/payments/{payment_hash}.
   */
  app.post('/webhooks/lnbits', async (request) => {
    const query = parse(webhookQuerySchema, request.query, 'token');
    if (
      !timingSafeEqualString(
        query.token,
        services.config.lightning.webhookToken,
      )
    ) {
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

    const result =
      await services.paymentIntents.applyLightningPayment(paymentHash);
    services.logger.info(
      { paymentHash, status: result.status, idTransacao: result.id_transacao },
      'webhook do LNbits processado',
    );
    return result;
  });

  app.post(
    '/admin/api/clients',
    { preHandler: adminAuth },
    async (request, reply) => {
      const body = parse(createClientSchema, request.body, 'corpo');
      const created = await services.clients.create({
        name: body.name,
        webhookUrl: body.webhook_url,
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

  app.post(
    '/admin/api/sweeps/:id/retry',
    { preHandler: adminAuth },
    async (request) => {
      const params = parse(idParamsSchema, request.params, 'id');
      const sweep = await services.repos.findSweepById(params.id);
      if (!sweep) throw new NotFoundError('sweep nao encontrado');
      if (sweep.status === 'sweepado') {
        throw new ConflictError('sweep ja confirmado; nao ha o que reenviar');
      }
      if (sweep.txid) {
        if (!services.esplora) {
          throw new ConflictError(
            'tx do sweep nao pode ser conferido agora; retry recusado',
          );
        }
        try {
          const tx = await services.esplora.getTx(sweep.txid);
          if (tx.status.confirmed) {
            throw new ConflictError(
              'tx do sweep ja esta confirmado; nao reenvie',
            );
          }
          throw new ConflictError(
            'tx do sweep ainda esta na mempool; espere o RBF em vez de montar outro gasto',
          );
        } catch (err) {
          if (err instanceof ConflictError) throw err;
          if (!isEsploraNotFound(err)) throw err;
        }
      }
      await services.repos.restoreOnchainPayments(sweep.inputs);
      const updated = await services.repos.updateSweep({
        id: sweep.id,
        status: 'falhou',
        lastError: 'retry manual solicitado pelo admin',
        attempts: 0,
        lastCheckedAt: new Date(),
      });
      services.logger.info({ sweepId: sweep.id }, 'retry de sweep solicitado');
      return updated;
    },
  );
}
