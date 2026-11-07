import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { encryptSecret } from '../crypto/cipher.js';
import { sha256Hex } from '../crypto/hmac.js';
import type { Repositories } from '../db/repositories.js';
import { ConflictError, ValidationError } from '../domain/errors.js';
import {
  buildPossessionMessage,
  generatePossessionNonce,
  normalizePossessionAddress,
  POSSESSION_CHALLENGE_TTL_MS,
  verifyPossessionSignature,
} from '../domain/possession.js';
import { USER_API_SCOPES, type PossessionPurpose } from '../domain/types.js';
import type { Logger } from '../logger.js';

export type DeviceChallengeDto = {
  nonce: string;
  message: string;
  expires_at: string;
};

export type DeviceClientDto = {
  client_id: string;
  api_key: string;
  request_secret: string;
};

export type DeviceClientServiceDeps = {
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  now?: () => Date;
};

/**
 * Cliente de device (C6): o perfil pessoal do app.
 *
 * O app nao tem conta nem senha: a identidade e o endereco da carteira. Para
 * virar cliente do motor ele prova que controla o endereco (C12) assinando um
 * desafio; so depois recebe a credencial (api key + request secret), que
 * guarda no Keychain e usa para assinar as chamadas.
 *
 * Um cliente ativo por endereco: quem perde a credencial se registra de novo
 * e recebe a mesma identidade — o historico e por endereco, entao nao se perde.
 */
export class DeviceClientService {
  constructor(private readonly deps: DeviceClientServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async issueChallenge(input: {
    purpose: PossessionPurpose;
    address?: string | null;
  }): Promise<DeviceChallengeDto> {
    const address = input.address
      ? normalizePossessionAddress(input.address)
      : null;
    const nonce = generatePossessionNonce();
    const target =
      address ??
      `0x${randomBytes(20).toString('hex')}`;
    const message = buildPossessionMessage({
      purpose: input.purpose,
      address: target,
      nonce,
    });
    const expiresAt = new Date(this.now().getTime() + POSSESSION_CHALLENGE_TTL_MS);
    await this.deps.repos.createPossessionChallenge({
      nonce,
      address: target,
      purpose: input.purpose,
      message,
      expiresAt,
    });
    return {
      nonce,
      message,
      expires_at: expiresAt.toISOString(),
    };
  }

  /**
   * Confere a prova de posse de um endereco (usado pela loja, F4).
   *
   * O desafio e consumido: um nonce, uma prova. Sem prova valida, o cadastro
   * da carteira do cliente nao acontece.
   */
  async verify(input: {
    address: string;
    purpose: PossessionPurpose;
    proof: { nonce: string; signature: string };
  }): Promise<boolean> {
    const address = normalizePossessionAddress(input.address);
    const challenge = await this.deps.repos.consumePossessionChallenge(
      input.proof.nonce,
      this.now(),
    );
    if (!challenge) return false;
    if (challenge.purpose !== input.purpose) return false;
    if (challenge.address.toLowerCase() !== address.toLowerCase()) return false;
    return verifyPossessionSignature({
      address,
      message: challenge.message,
      signature: input.proof.signature,
    });
  }

  async register(input: {
    address: string;
    chain?: string | null;
    proof: { nonce: string; signature: string };
  }): Promise<DeviceClientDto> {
    const address = normalizePossessionAddress(input.address);
    const challenge = await this.deps.repos.consumePossessionChallenge(
      input.proof.nonce,
      this.now(),
    );
    if (!challenge) {
      throw new ValidationError(
        'desafio invalido, expirado ou ja usado: peca um novo desafio',
      );
    }
    if (challenge.address.toLowerCase() !== address.toLowerCase()) {
      throw new ValidationError('o desafio nao foi emitido para este endereco');
    }
    const valid = await verifyPossessionSignature({
      address,
      message: challenge.message,
      signature: input.proof.signature,
    });
    if (!valid) {
      throw new ValidationError('prova de posse invalida');
    }

    const existing = await this.deps.repos.findClientBySettlementAddress(address);
    if (existing) {
      if (existing.status !== 'ativo') {
        throw new ConflictError('cliente desativado: fale com o suporte');
      }
      const rotated = await this.rotate(existing.id);
      await this.deps.repos.insertAuditEvent({
        actor: 'device',
        action: 'client.credentials_rotated',
        entity: 'api_client',
        entityId: existing.id,
        metadata: { reason: 're-registro', address },
      });
      return rotated;
    }

    const created = await this.create(address);
    await this.deps.repos.insertAuditEvent({
      actor: 'device',
      action: 'client.created',
      entity: 'api_client',
      entityId: created.client_id,
      metadata: { address, chain: input.chain ?? null },
    });
    return created;
  }

  private async rotate(clientId: string): Promise<DeviceClientDto> {
    const apiKey = `mk_btc_live_${randomBytes(32).toString('base64url')}`;
    const requestSecret = randomBytes(32).toString('base64url');
    const kid = this.deps.config.crypto.activeKid;
    const key = this.deps.config.crypto.keyring[kid];
    if (!key) throw new Error('chave ativa de cifragem ausente');
    await this.deps.repos.rotateClientKey(clientId, {
      apiKeyHash: sha256Hex(apiKey),
      apiKeyPrefix: apiKey.slice(0, 20),
      requestSecretEnc: encryptSecret(requestSecret, key, kid, clientId),
    });
    return { client_id: clientId, api_key: apiKey, request_secret: requestSecret };
  }

  private async create(address: string): Promise<DeviceClientDto> {
    const id = randomUUID();
    const apiKey = `mk_btc_live_${randomBytes(32).toString('base64url')}`;
    const requestSecret = randomBytes(32).toString('base64url');
    const webhookSecret = randomBytes(32).toString('base64url');
    const kid = this.deps.config.crypto.activeKid;
    const key = this.deps.config.crypto.keyring[kid];
    if (!key) throw new Error('chave ativa de cifragem ausente');
    await this.deps.repos.createClient({
      id,
      name: `app ${address.slice(0, 10)}`,
      apiKeyPrefix: apiKey.slice(0, 20),
      apiKeyHash: sha256Hex(apiKey),
      requestSecretEnc: encryptSecret(requestSecret, key, kid, id),
      webhookUrl: '',
      webhookSecretEnc: encryptSecret(webhookSecret, key, kid, id),
      scopes: [...USER_API_SCOPES],
      clientType: 'usuario',
      settlementAddress: address,
    });
    this.deps.logger.info({ clientId: id, address }, 'cliente de device criado');
    return { client_id: id, api_key: apiKey, request_secret: requestSecret };
  }
}
