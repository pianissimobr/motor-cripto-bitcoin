import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { encryptSecret } from '../crypto/cipher.js';
import { sha256Hex } from '../crypto/hmac.js';
import type { Repositories } from '../db/repositories.js';
import { ValidationError } from '../domain/errors.js';
import type { ClientStatus } from '../domain/types.js';
import type { Logger } from '../logger.js';

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
};

function normalizeWebhookUrl(value: string, isProduction: boolean): string {
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
  return url.toString();
}

export class ClientService {
  constructor(private readonly deps: ClientServiceDeps) {}

  async create(input: { name: string; webhookUrl: string }): Promise<CreatedClient> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 80) {
      throw new ValidationError('name deve ter entre 1 e 80 caracteres');
    }
    const webhookUrl = normalizeWebhookUrl(
      input.webhookUrl,
      this.deps.config.service.isProduction,
    );

    const id = randomUUID();
    const apiKey = `mk_btc_live_${randomBytes(32).toString('base64url')}`;
    const requestSecret = randomBytes(32).toString('base64url');
    const webhookSecret = randomBytes(32).toString('base64url');

    const key = this.deps.config.crypto.keyring[this.deps.config.crypto.activeKid];
    if (!key) throw new Error('chave ativa de cifragem ausente');
    const kid = this.deps.config.crypto.activeKid;
    const requestSecretEnc = encryptSecret(requestSecret, key, kid, id);
    const webhookSecretEnc = encryptSecret(webhookSecret, key, kid, id);

    const client = await this.deps.repos.createClient({
      id,
      name,
      apiKeyPrefix: apiKey.slice(0, 20),
      apiKeyHash: sha256Hex(apiKey),
      requestSecretEnc,
      webhookUrl,
      webhookSecretEnc,
    });

    await this.deps.repos.insertAuditEvent({
      actor: 'admin',
      action: 'client.created',
      entity: 'api_client',
      entityId: client.id,
      metadata: { name: client.name, webhookHost: new URL(client.webhookUrl).host },
    });

    this.deps.logger.info(
      { clientId: client.id, name: client.name },
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

  async list(): Promise<ClientSummary[]> {
    const clients = await this.deps.repos.listClients();
    return clients.map((client) => ({
      id: client.id,
      name: client.name,
      apiKeyPrefix: client.apiKeyPrefix,
      webhookUrl: client.webhookUrl,
      status: client.status,
      createdAt: client.createdAt,
    }));
  }
}
