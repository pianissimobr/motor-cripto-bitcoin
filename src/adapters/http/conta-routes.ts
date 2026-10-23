import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccountService } from '../../core/services/account-service.js';
import type { Motor } from '../../core/index.js';

/**
 * Porta do cliente. Não aceita o token da loja: a sessão é outra.
 */
export function registerContaRoutes(app: FastifyInstance, motor: Motor): void {
  const accounts = new AccountService({
    repos: motor.repos,
    customers: motor.customers,
    links: motor.links,
  });

  const tokenDe = (header: unknown): string => (typeof header === 'string' ? header.trim() : '');

  app.post('/api/conta/criar', async (request, reply) => {
    const body = z
      .object({
        nome: z.string().min(2).max(200),
        email: z.string().email().max(320),
        usuario: z.string().min(3).max(32),
        senha: z.string().min(8).max(200),
      })
      .parse(request.body);
    const customer = await accounts.registrar(body);
    return reply.code(201).send({ id: customer.id });
  });

  app.post('/api/conta/entrar', async (request) => {
    const body = z
      .object({
        identificador: z.string().min(1).max(320),
        senha: z.string().min(1).max(200),
      })
      .parse(request.body);
    const { token, customer } = await accounts.entrar(body.identificador, body.senha);
    const conta = await motor.repos.accounts.findByClienteId(customer.id);
    return {
      token,
      nome: customer.nome,
      email: customer.email,
      usuario: conta?.usuario ?? '',
    };
  });

  app.post('/api/conta/sair', async (request, reply) => {
    await accounts.sair(tokenDe(request.headers['x-conta-token']));
    return reply.code(204).send();
  });

  app.get('/api/conta/eu', async (request) => {
    const { customer, usuario } = await accounts.quem(tokenDe(request.headers['x-conta-token']));
    return { id: customer.id, nome: customer.nome, email: customer.email, usuario };
  });

  app.patch('/api/conta/eu', async (request) => {
    const body = z
      .object({
        nome: z.string().min(2).max(200).optional(),
        email: z.string().email().max(320).optional(),
        usuario: z.string().min(3).max(32).optional(),
        senha: z.string().min(8).max(200).optional(),
      })
      .parse(request.body);
    const { customer, usuario } = await accounts.atualizar(
      tokenDe(request.headers['x-conta-token']),
      body,
    );
    return { id: customer.id, nome: customer.nome, email: customer.email, usuario };
  });

  app.post('/api/conta/cobranca', async (request) => {
    const body = z
      .object({
        valor: z.union([z.string().trim().min(1).max(20), z.number()]),
      })
      .parse(request.body);
    return accounts.cobrar(tokenDe(request.headers['x-conta-token']), body.valor);
  });

  app.delete('/api/conta/eu', async (request, reply) => {
    await accounts.excluir(tokenDe(request.headers['x-conta-token']));
    return reply.code(204).send();
  });
}
