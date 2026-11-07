import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiScope } from '../domain/types.js';
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors.js';
import { isPossessionPurpose } from '../domain/possession.js';
import { guessPixKeyType, maskPixKey } from '../domain/brcode.js';
import { createApiAuth } from './auth.js';
import type { ApiServices } from './api-routes.js';

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`${what} invalido`, result.error.issues);
  }
  return result.data;
}

const challengeSchema = z
  .object({
    purpose: z.string().trim().min(1).max(40),
    address: z.string().trim().max(64).optional(),
    /** A rede da carteira (o app manda; o registro tambem aceita). */
    chain: z.string().trim().max(20).optional(),
  })
  .strict();

const registerClientSchema = z
  .object({
    address: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido'),
    chain: z.string().trim().max(20).optional(),
    proof: z
      .object({
        nonce: z.string().trim().min(8).max(128),
        signature: z.string().trim().regex(/^0x[a-fA-F0-9]+$/, 'assinatura invalida'),
      })
      .strict(),
  })
  .strict();

const operationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().min(1).max(64).optional(),
});

const addressQuerySchema = z.object({
  address: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido'),
});

const payerLimitsQuerySchema = z.object({
  payer_tax: z.string().trim().min(1).max(32),
});

/**
 * Chave Pix do proprio usuario.
 *
 * E o trilho "Pix direto": com a chave configurada, o motor monta o BR Code
 * e o pagamento cai direto na conta do usuario, sem passar pela LuniumPay e
 * sem conversao.
 */
const pixKeySchema = z
  .object({
    pix_key: z.string().trim().min(1).max(140),
    pix_key_type: z
      .enum(['cpf', 'cnpj', 'email', 'phone', 'random'])
      .optional(),
    merchant_name: z.string().trim().max(25).optional(),
    city: z.string().trim().max(15).optional(),
  })
  .strict();

const revocationSchema = z
  .object({
    address: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/, 'endereco invalido'),
    merchant_id: z.string().trim().max(64).optional(),
  })
  .strict();

/**
 * Rotas do perfil pessoal (F2/C5/C12).
 *
 * `challenges` e `clients` sao publicas de proposito: e o proprio app que
 * se registra, e o que prova a posse do endereco e a assinatura. As demais
 * exigem a credencial do device.
 */
export function registerUserRoutes(app: FastifyInstance, services: ApiServices): void {
  const apiAuth = (scope: ApiScope) =>
    createApiAuth(
      {
        repos: services.repos,
        config: services.config,
        logger: services.logger,
      },
      scope,
    );

  app.post('/v1/user/challenges', async (request, reply) => {
    if (!services.deviceClients) {
      throw new ValidationError('registro de device indisponivel');
    }
    const body = parse(challengeSchema, request.body ?? {}, 'corpo');
    if (!isPossessionPurpose(body.purpose)) {
      throw new ValidationError('purpose invalido');
    }
    const challenge = await services.deviceClients.issueChallenge({
      purpose: body.purpose,
      address: body.address ?? null,
    });
    return reply.status(201).send(challenge);
  });

  app.post('/v1/user/clients', async (request, reply) => {
    if (!services.deviceClients) {
      throw new ValidationError('registro de device indisponivel');
    }
    const body = parse(registerClientSchema, request.body ?? {}, 'corpo');
    const created = await services.deviceClients.register({
      address: body.address,
      chain: body.chain ?? null,
      proof: body.proof,
    });
    return reply.status(201).send(created);
  });

  app.get(
    '/v1/user/operations',
    { preHandler: apiAuth('operations:read') },
    async (request) => {
      if (!services.operations) {
        throw new ValidationError('extrato indisponivel');
      }
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const address = client.settlementAddress;
      if (!address) {
        throw new ValidationError('cliente sem endereco de liquidacao');
      }
      const query = parse(operationsQuerySchema, request.query, 'query string');
      return services.operations.list({
        address,
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
    },
  );

  app.get(
    '/v1/addresses/:address/operations',
    { preHandler: apiAuth('operations:read') },
    async (request) => {
      if (!services.operations) {
        throw new ValidationError('extrato indisponivel');
      }
      const params = parse(addressQuerySchema, request.params, 'endereco');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      // O extrato e do dono do endereco: o cadastro de device e aberto, entao
      // sem esta trava qualquer um leria o historico de qualquer carteira.
      const own = (client.settlementAddress ?? '').toLowerCase();
      if (!own || own !== params.address.toLowerCase()) {
        throw new ForbiddenError('so da para ler o extrato do proprio endereco');
      }
      const query = parse(operationsQuerySchema, request.query, 'query string');
      return services.operations.list({
        address: params.address,
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
    },
  );

  app.get(
    '/v1/user/flags',
    { preHandler: apiAuth('operations:read') },
    async (request) => {
      if (!services.flags) {
        throw new ValidationError('flags indisponiveis');
      }
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      return services.flags.get();
    },
  );

  app.get(
    '/v1/user/payer-limits',
    { preHandler: apiAuth('operations:read') },
    async (request) => {
      if (!services.lunium) {
        throw new ValidationError('PIX indisponivel');
      }
      const query = parse(payerLimitsQuerySchema, request.query, 'query string');
      return services.lunium.getLimits(query.payer_tax);
    },
  );

  app.put(
    '/v1/user/pix-key',
    { preHandler: apiAuth('operations:read') },
    async (request, reply) => {
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const address = client.settlementAddress;
      if (!address) {
        throw new ValidationError('cliente sem endereco de liquidacao');
      }
      const body = parse(pixKeySchema, request.body ?? {}, 'corpo');
      const saved = await services.repos.createClientPixKey({
        clientId: client.id,
        address: address.toLowerCase(),
        pixKey: body.pix_key,
        pixKeyType: body.pix_key_type ?? guessPixKeyType(body.pix_key) ?? null,
        merchantName: body.merchant_name ?? null,
        city: body.city ?? null,
      });
      return reply.status(200).send({
        pix_key: maskPixKey(saved.pixKey),
        pix_key_type: saved.pixKeyType,
        merchant_name: saved.merchantName,
        city: saved.city,
        updated_at: saved.updatedAt.toISOString(),
      });
    },
  );

  app.get(
    '/v1/user/pix-key',
    { preHandler: apiAuth('operations:read') },
    async (request) => {
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const saved = await services.repos.findClientPixKeyByClientId(client.id);
      if (!saved) return { pix_key: null };
      return {
        pix_key: maskPixKey(saved.pixKey),
        pix_key_type: saved.pixKeyType,
        merchant_name: saved.merchantName,
        city: saved.city,
        updated_at: saved.updatedAt.toISOString(),
      };
    },
  );

  app.post(
    '/v1/user/address-revocations',
    { preHandler: apiAuth('operations:read') },
    async (request, reply) => {
      const body = parse(revocationSchema, request.body ?? {}, 'corpo');
      const client = request.apiClient;
      if (!client) throw new UnauthorizedError('cliente nao autenticado');
      const ownAddress = (client.settlementAddress ?? '').toLowerCase();
      if (!ownAddress) {
        throw new ForbiddenError('cliente sem endereco proprio nao revoga enderecos');
      }
      if (ownAddress !== body.address.toLowerCase()) {
        throw new ValidationError('so da para revogar o proprio endereco');
      }
      const merchantId = body.merchant_id ?? null;
      const revocation = await services.repos.createAddressRevocation({
        address: body.address,
        merchantId,
      });
      await services.repos.insertAuditEvent({
        actor: `client:${client.id}`,
        action: 'address.revoked',
        entity: 'address_revocation',
        entityId: revocation.id,
        metadata: { address: body.address, merchantId },
      });
      return reply.status(201).send({
        address: revocation.address,
        merchant_id: revocation.merchantId,
        revoked_at: revocation.revokedAt.toISOString(),
      });
    },
  );
}
