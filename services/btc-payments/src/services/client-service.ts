import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { encryptSecret } from '../crypto/cipher.js';
import { sha256Hex } from '../crypto/hmac.js';
import type { Repositories } from '../db/repositories.js';
import { ValidationError, NotFoundError } from '../domain/errors.js';
import { DEFAULT_API_SCOPES, type ApiClient, type ApiScope, type ClientStatus } from '../domain/types.js';
import type { Logger } from '../logger.js';
import {
  assertWebhookUrl,
  defaultHostLookup,
  type HostLookup,
} from '../net/webhook-url.js';

export type CreatedClient = {
  id: string;
  name: string;
  webhookUrl: string;
  apiKey: string;
  requestSecret: string;
  webhookSecret: string;
  createdAt: Date;
};

export type ClientSummary = {
  id: string;
  name: string;
  apiKeyPrefix: string;
  webhookUrl: string;
  status: ClientStatus;
  createdAt: Date;
};

export type ClientServiceDeps = {
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  resolveWebhookHost?: HostLookup;
};

export class ClientService {
  constructor(private readonly deps: ClientServiceDeps) {}

  private async normalizeWebhookUrl(value: string): Promise<string> {
    const isProduction = this.deps.config.service.isProduction;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ValidationError('webhook_url invalida');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new ValidationError('webhook_url deve usar http(s)');
    }
    if (isProduction && url.protocol !== 'https:') {
      throw new ValidationError('webhook_url precisa ser https em producao');
    }
    const normalized = url.toString();
    await assertWebhookUrl(normalized, {
      requireHttps: isProduction,
      lookupHost: this.deps.resolveWebhookHost ?? defaultHostLookup,
      allowLoopback: !isProduction,
    });
    return normalized;
  }

  private async provision(input: {
    name: string;
    webhookUrl: string;
    scopes?: ApiScope[];
    actor: string;
  }): Promise<CreatedClient> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 80) {
      throw new ValidationError('name deve ter entre 1 e 80 caracteres');
    }
    const rawWebhook = input.webhookUrl.trim();
    const webhookUrl = rawWebhook.length > 0 ? await this.normalizeWebhookUrl(rawWebhook) : '';

    const id = randomUUID();
    const apiKey = `mk_btc_live_${randomBytes(32).toString('base64url')}`;
    const requestSecret = randomBytes(32).toString('base64url');
    const webhookSecret = randomBytes(32).toString('base64url');

    const key = this.deps.config.crypto.keyring[this.deps.config.crypto.activeKid];
    if (!key) throw new Error('chave ativa de cifragem ausente');
    const kid = this.deps.config.crypto.activeKid;
    const requestSecretEnc = encryptSecret(requestSecret, key, kid, id);
    const webhookSecretEnc = encryptSecret(webhookSecret, key, kid, id);

    const scopes = input.scopes ?? [...DEFAULT_API_SCOPES];
    const client = await this.deps.repos.createClient({
      id,
      name,
      apiKeyPrefix: apiKey.slice(0, 20),
      apiKeyHash: sha256Hex(apiKey),
      requestSecretEnc,
      webhookUrl,
      webhookSecretEnc,
      scopes,
    });

    const webhookHost = webhookUrl.length > 0
      ? new URL(webhookUrl).host
      : null;
    await this.deps.repos.insertAuditEvent({
      actor: input.actor,
      action: 'client.created',
      entity: 'api_client',
      entityId: client.id,
      metadata: { name: client.name, ...(webhookHost ? { webhookHost } : {}) },
    });

    this.deps.logger.info(
      { clientId: client.id, name: client.name, actor: input.actor },
      'cliente da API criado',
    );

    return {
      id: client.id,
      name: client.name,
      webhookUrl: client.webhookUrl,
      apiKey,
      requestSecret,
      webhookSecret,
      createdAt: client.createdAt,
    };
  }

  async create(input: {
    name: string;
    webhookUrl: string;
    scopes?: ApiScope[];
  }): Promise<CreatedClient> {
    return this.provision({
      name: input.name,
      webhookUrl: input.webhookUrl,
      ...(input.scopes ? { scopes: input.scopes } : {}),
      actor: 'admin',
    });
  }

  /** Cria a loja default no cadastro, ainda sem webhook configurado. */
  async createMerchant(input: { name: string }): Promise<CreatedClient> {
    return this.provision({
      name: input.name,
      webhookUrl: '',
      actor: 'portal',
    });
  }

  async list(): Promise<ClientSummary[]> {
    const clients = await this.deps.repos.listClients();
    return clients.map((client) => this.summary(client));
  }

  private summary(client: ApiClient): ClientSummary {
    return {
      id: client.id,
      name: client.name,
      apiKeyPrefix: client.apiKeyPrefix,
      webhookUrl: client.webhookUrl,
      status: client.status,
      createdAt: client.createdAt,
    };
  }

  async setProfile(
    id: string,
    input: { name?: string; webhookUrl?: string },
    actor = 'portal',
  ): Promise<ClientSummary> {
    let webhookUrl = input.webhookUrl;
    if (webhookUrl !== undefined) {
      webhookUrl =
        webhookUrl.trim().length > 0 ? await this.normalizeWebhookUrl(webhookUrl) : '';
    }
    const client = await this.deps.repos.updateClientProfile(id, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    } as { name?: string; webhookUrl?: string });
    if (!client) throw new NotFoundError('cliente nao encontrado');
    await this.deps.repos.insertAuditEvent({
      actor,
      action: 'client.updated',
      entity: 'api_client',
      entityId: client.id,
    });
    return this.summary(client);
  }

  async rotateApiKey(
    id: string,
    actor = 'portal',
  ): Promise<{ apiKey: string; requestSecret: string }> {
    const client = await this.deps.repos.findClientById(id);
    if (!client) throw new NotFoundError('cliente nao encontrado');
    const apiKey = `mk_btc_live_${randomBytes(32).toString('base64url')}`;
    const requestSecret = randomBytes(32).toString('base64url');
    const key = this.deps.config.crypto.keyring[this.deps.config.crypto.activeKid];
    if (!key) throw new Error('chave ativa de cifragem ausente');
    const requestSecretEnc = encryptSecret(
      requestSecret,
      key,
      this.deps.config.crypto.activeKid,
      id,
    );
    await this.deps.repos.rotateClientKey(id, {
      apiKeyHash: sha256Hex(apiKey),
      apiKeyPrefix: apiKey.slice(0, 20),
      requestSecretEnc,
    });
    await this.deps.repos.insertAuditEvent({
      actor,
      action: 'client.key_rotated',
      entity: 'api_client',
      entityId: id,
    });
    this.deps.logger.info({ clientId: id, actor }, 'api key rotacionada');
    return { apiKey, requestSecret };
  }
}