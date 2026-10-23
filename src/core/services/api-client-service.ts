import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizeAddress } from '../domain/address.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type { ApiClient, ApiClientWallet } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { MotorRepositories } from '../ports/index.js';

const API_KEY_PREFIX = 'mk_live_';
const WEBHOOK_SECRET_PREFIX = 'whsec_';

export type CreatedApiClient = {
  client: ApiClient;
  apiKey: string;
  requestSecret: string;
};

export type ApiClientServiceDeps = {
  repos: MotorRepositories;
  logger: Logger;
};

/**
 * Cadastro e autenticacao dos clientes da API.
 *
 * A API key e mostrada uma unica vez (na criacao/rotacao). O banco guarda
 * somente o SHA-256; o prefixo fica visivel para o admin identificar a chave.
 */
export class ApiClientService {
  constructor(private readonly deps: ApiClientServiceDeps) {}

  async create(input: {
    nome: string;
    webhookUrl: string;
    actor?: string;
    ip?: string | null;
  }): Promise<CreatedApiClient> {
    const nome = input.nome.trim();
    if (nome.length < 2) throw new ValidationError('nome do cliente muito curto');
    validateWebhookUrl(input.webhookUrl);

    const id = randomUUID();
    const apiKey = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const webhookSecret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
    const requestSecret = `req_${randomBytes(32).toString('base64url')}`;
    const client = await this.deps.repos.apiClients.create({
      id,
      nome,
      apiKeyHash: hashApiKey(apiKey),
      apiKeyPrefix: apiKey.slice(0, 16),
      webhookUrl: input.webhookUrl,
      webhookSecret,
      requestSecret,
    });

    await this.deps.repos.audit.record({
      ator: input.actor ?? 'admin',
      acao: 'api_cliente.criado',
      entidade: 'api_cliente',
      entidadeId: client.id,
      detalhes: { nome: client.nome, webhookUrl: client.webhookUrl },
      ip: input.ip ?? null,
    });
    this.deps.logger.info({ apiClienteId: client.id }, 'cliente da API criado');
    return { client, apiKey, requestSecret };
  }

  async authenticate(apiKey: string): Promise<ApiClient | null> {
    if (!apiKey.startsWith(API_KEY_PREFIX)) return null;
    const client = await this.deps.repos.apiClients.findByApiKeyHash(hashApiKey(apiKey));
    if (!client || client.status !== 'ativo') return null;
    return client;
  }

  async list(): Promise<ApiClient[]> {
    return this.deps.repos.apiClients.list();
  }

  async get(id: string): Promise<ApiClient> {
    const client = await this.deps.repos.apiClients.findById(id);
    if (!client) throw new NotFoundError('cliente da API nao encontrado');
    return client;
  }

  async update(
    id: string,
    input: { nome?: string; webhookUrl?: string; status?: 'ativo' | 'inativo' },
    actor = 'admin',
  ): Promise<ApiClient> {
    if (input.webhookUrl !== undefined) validateWebhookUrl(input.webhookUrl);
    const client = await this.deps.repos.apiClients.update(id, input);
    if (!client) throw new NotFoundError('cliente da API nao encontrado');
    await this.deps.repos.audit.record({
      ator: actor,
      acao: 'api_cliente.atualizado',
      entidade: 'api_cliente',
      entidadeId: id,
      detalhes: { ...input },
    });
    return client;
  }

  async rotateKey(
    id: string,
    actor = 'admin',
  ): Promise<{ client: ApiClient; apiKey: string; requestSecret: string }> {
    const apiKey = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const requestSecret = `req_${randomBytes(32).toString('base64url')}`;
    const client = await this.deps.repos.apiClients.rotateKey(
      id,
      hashApiKey(apiKey),
      apiKey.slice(0, 16),
      requestSecret,
    );
    if (!client) throw new NotFoundError('cliente da API nao encontrado');
    await this.deps.repos.audit.record({
      ator: actor,
      acao: 'api_cliente.chave_rotacionada',
      entidade: 'api_cliente',
      entidadeId: id,
      detalhes: { apiKeyPrefix: client.apiKeyPrefix },
    });
    return { client, apiKey, requestSecret };
  }

  async rotateWebhookSecret(
    id: string,
    actor = 'admin',
  ): Promise<{ client: ApiClient; webhookSecret: string }> {
    const webhookSecret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
    const client = await this.deps.repos.apiClients.rotateWebhookSecret(id, webhookSecret);
    if (!client) throw new NotFoundError('cliente da API nao encontrado');
    await this.deps.repos.audit.record({
      ator: actor,
      acao: 'api_cliente.webhook_secret_rotacionado',
      entidade: 'api_cliente',
      entidadeId: id,
      detalhes: {},
    });
    return { client, webhookSecret };
  }

  async addWallet(
    apiClienteId: string,
    input: { label: string; chain: string; address: string },
    actor = 'admin',
  ): Promise<ApiClientWallet> {
    await this.get(apiClienteId);
    const label = input.label.trim();
    if (label.length < 1 || label.length > 80) {
      throw new ValidationError('label da carteira deve ter entre 1 e 80 caracteres');
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(input.address)) {
      throw new ValidationError('endereco da carteira invalido');
    }
    const existing = await this.deps.repos.apiClientWallets.findByClientAndAddress(
      apiClienteId,
      input.address,
    );
    if (existing) throw new ValidationError('carteira ja cadastrada para este cliente');

    const wallet = await this.deps.repos.apiClientWallets.create({
      apiClienteId,
      label,
      chain: input.chain,
      address: normalizeAddress(input.address),
    });
    await this.deps.repos.audit.record({
      ator: actor,
      acao: 'api_cliente.carteira_criada',
      entidade: 'api_cliente',
      entidadeId: apiClienteId,
      detalhes: { walletId: wallet.id, chain: wallet.chain, address: wallet.address },
    });
    return wallet;
  }

  async listWallets(apiClienteId: string): Promise<ApiClientWallet[]> {
    await this.get(apiClienteId);
    return this.deps.repos.apiClientWallets.listByClient(apiClienteId);
  }
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

function validateWebhookUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('webhookUrl invalida');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('webhookUrl deve usar http(s)');
  }
}
