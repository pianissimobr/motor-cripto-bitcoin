import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PixApiClient, type PixApiConfig, type PixEnvironment, type PixPsp } from '../adapters/pix-api/client.js';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto/cipher.js';
import type { Db } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { merchantPixBanks } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import type { Logger } from '../logger.js';
import { assertWebhookUrl, defaultHostLookup, type HostLookup } from '../net/webhook-url.js';
import type { PixDiretoGateway } from './invoice-service.js';

export type SaveBankInput = {
  psp: PixPsp;
  environment: PixEnvironment;
  baseUrl?: string | null | undefined;
  tokenUrl?: string | null | undefined;
  clientId: string;
  /** Vazio na edicao: mantem o segredo atual. */
  clientSecret?: string | undefined;
  /** .p12 em base64; vazio na edicao: mantem o atual. */
  certificateP12Base64?: string | undefined;
  certificatePassphrase?: string | undefined;
  pixKey: string;
};

type Row = typeof merchantPixBanks.$inferSelect;

export type PixDiretoDeps = {
  db: Db;
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  /** Troca o cliente HTTP (testes). */
  clientFactory?: (config: PixApiConfig) => Pick<PixApiClient, 'check' | 'createCob' | 'getCob'>;
  lookupHost?: HostLookup;
  now?: () => Date;
};

/**
 * Pix na conta da propria loja, pela API Pix do banco dela. O motor so cria a
 * cobranca e confere o pagamento: o dinheiro vai do pagador para o banco da
 * loja, sem passar por ninguem.
 */
export class PixDiretoService implements PixDiretoGateway {
  private readonly clients = new Map<string, { key: string; client: Pick<PixApiClient, 'check' | 'createCob' | 'getCob'> }>();
  private readonly now: () => Date;

  constructor(private readonly deps: PixDiretoDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private seal(value: string, clientId: string): string {
    const kid = this.deps.config.crypto.activeKid;
    const key = this.deps.config.crypto.keyring[kid];
    if (!key) throw new Error('chave ativa de cifragem ausente');
    return encryptSecret(value, key, kid, `pixbank:${clientId}`);
  }

  private open(envelope: string, clientId: string): string {
    return decryptSecret(envelope, this.deps.config.crypto.keyring, `pixbank:${clientId}`);
  }

  private async find(clientId: string): Promise<Row | null> {
    const rows = await this.deps.db.select().from(merchantPixBanks).where(eq(merchantPixBanks.clientId, clientId)).limit(1);
    return rows[0] ?? null;
  }

  private apiConfig(row: Row): PixApiConfig {
    return {
      psp: row.psp,
      environment: row.environment,
      baseUrl: row.baseUrl,
      tokenUrl: row.tokenUrl,
      clientId: row.oauthClientId,
      clientSecret: this.open(row.oauthClientSecretEnc, row.clientId),
      certificateP12Base64: this.open(row.certificateEnc, row.clientId),
      certificatePassphrase: row.certificatePassphraseEnc ? this.open(row.certificatePassphraseEnc, row.clientId) : null,
      pixKey: row.pixKey,
    };
  }

  private build(config: PixApiConfig) {
    return this.deps.clientFactory ? this.deps.clientFactory(config) : new PixApiClient(config);
  }

  /** Um cliente por loja, refeito quando a configuracao muda (token em cache). */
  private clientFor(row: Row) {
    const key = createHash('sha256').update(`${row.updatedAt.getTime()}:${row.clientId}`).digest('hex');
    const cached = this.clients.get(row.clientId);
    if (cached && cached.key === key) return cached.client;
    const client = this.build(this.apiConfig(row));
    this.clients.set(row.clientId, { key, client });
    return client;
  }

  async isConfigured(clientId: string): Promise<boolean> {
    const row = await this.find(clientId);
    return Boolean(row?.enabled && !row.lastCheckError);
  }

  view(row: Row | null) {
    if (!row) return { configured: false as const };
    return {
      configured: true as const,
      psp: row.psp,
      environment: row.environment,
      base_url: row.baseUrl,
      token_url: row.tokenUrl,
      client_id: row.oauthClientId,
      pix_key: row.pixKey,
      enabled: row.enabled,
      last_check_at: row.lastCheckAt?.toISOString() ?? null,
      last_check_error: row.lastCheckError,
    };
  }

  async get(clientId: string) {
    return this.view(await this.find(clientId));
  }

  private async checkUrl(value: string | null | undefined, field: string): Promise<string | null> {
    if (!value) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') throw new Error('https');
      // O endereco vem da loja: nada de rede interna.
      await assertWebhookUrl(url.toString(), {
        requireHttps: true,
        lookupHost: this.deps.lookupHost ?? defaultHostLookup,
        allowLoopback: !this.deps.config.service.isProduction,
      });
      return url.toString().replace(/\/+$/, '');
    } catch {
      throw new ValidationError(`${field} invalido: use https e um endereco publico`);
    }
  }

  /**
   * Salva e ja testa (pede o token com o certificado). So fica ligado se o
   * teste passar; o erro fica visivel no painel.
   */
  async save(clientId: string, input: SaveBankInput, actor: string) {
    const current = await this.find(clientId);
    const secret = input.clientSecret || (current ? this.open(current.oauthClientSecretEnc, clientId) : '');
    const cert = input.certificateP12Base64 || (current ? this.open(current.certificateEnc, clientId) : '');
    if (!secret) throw new ValidationError('informe o client_secret');
    if (!cert) throw new ValidationError('envie o certificado (.p12)');
    if (Buffer.from(cert, 'base64').length < 100) throw new ValidationError('certificado invalido');
    const passphrase =
      input.certificatePassphrase !== undefined
        ? input.certificatePassphrase
        : current?.certificatePassphraseEnc
          ? this.open(current.certificatePassphraseEnc, clientId)
          : '';
    const baseUrl = input.psp === 'outro' ? await this.checkUrl(input.baseUrl, 'endereco da API') : null;
    const tokenUrl = input.psp === 'outro' ? await this.checkUrl(input.tokenUrl, 'endereco do token') : null;
    if (input.psp === 'outro' && (!baseUrl || !tokenUrl)) throw new ValidationError('informe o endereco da API e do token');
    const pixKey = input.pixKey.trim();
    if (pixKey.length < 5 || pixKey.length > 77) throw new ValidationError('chave Pix invalida');

    const apiConfig: PixApiConfig = {
      psp: input.psp,
      environment: input.environment,
      baseUrl,
      tokenUrl,
      clientId: input.clientId.trim(),
      clientSecret: secret,
      certificateP12Base64: cert,
      certificatePassphrase: passphrase || null,
      pixKey,
    };
    let checkError: string | null = null;
    try {
      await this.build(apiConfig).check();
    } catch (err) {
      checkError = err instanceof Error ? err.message : String(err);
    }

    const values = {
      psp: input.psp,
      environment: input.environment,
      baseUrl,
      tokenUrl,
      oauthClientId: apiConfig.clientId,
      oauthClientSecretEnc: this.seal(secret, clientId),
      certificateEnc: this.seal(cert, clientId),
      certificatePassphraseEnc: passphrase ? this.seal(passphrase, clientId) : null,
      pixKey,
      enabled: checkError === null,
      lastCheckAt: this.now(),
      lastCheckError: checkError,
      updatedAt: this.now(),
    };
    await this.deps.db
      .insert(merchantPixBanks)
      .values({ clientId, ...values })
      .onConflictDoUpdate({ target: merchantPixBanks.clientId, set: values });
    this.clients.delete(clientId);
    await this.deps.repos.insertAuditEvent({
      actor,
      action: 'pix_bank.saved',
      entity: 'api_client',
      entityId: clientId,
      metadata: { psp: input.psp, environment: input.environment, ok: checkError === null },
    });
    return this.get(clientId);
  }

  async remove(clientId: string, actor: string) {
    const rows = await this.deps.db.delete(merchantPixBanks).where(eq(merchantPixBanks.clientId, clientId)).returning();
    if (rows.length === 0) throw new NotFoundError('banco nao configurado');
    this.clients.delete(clientId);
    await this.deps.repos.insertAuditEvent({ actor, action: 'pix_bank.removed', entity: 'api_client', entityId: clientId });
  }

  // ---- PixDiretoGateway (usado pela fatura)

  async createCharge(input: { clientId: string; txid: string; amountCents: bigint; description: string; expiresInSeconds: number }) {
    const row = await this.find(input.clientId);
    if (!row || !row.enabled) throw new ValidationError('Pix indisponivel no momento');
    const cob = await this.clientFor(row).createCob({
      txid: input.txid,
      amountCents: input.amountCents,
      expiresInSeconds: input.expiresInSeconds,
      description: input.description,
    });
    if (!cob.pixCopiaECola) throw new ValidationError('o banco nao devolveu o Pix copia e cola');
    if (cob.amountCents !== input.amountCents) throw new ValidationError('o banco devolveu outro valor para a cobranca');
    return { copypaste: cob.pixCopiaECola };
  }

  /**
   * Pago so com status CONCLUIDA **e** um Pix recebido de pelo menos o valor
   * da cobranca. O txHash da fatura vira o endToEndId (o comprovante).
   */
  async checkPaid(clientId: string, txid: string): Promise<{ paid: boolean; txHash: string | null }> {
    const row = await this.find(clientId);
    if (!row) return { paid: false, txHash: null };
    try {
      const cob = await this.clientFor(row).getCob(txid);
      const received = cob.payments.reduce((sum, p) => sum + p.amountCents, 0n);
      if (cob.status === 'CONCLUIDA' && received >= cob.amountCents && cob.payments[0]) {
        return { paid: true, txHash: cob.payments[0].endToEndId };
      }
    } catch (err) {
      this.deps.logger.warn({ err, clientId, txid }, 'falha ao consultar cobranca Pix no banco da loja');
    }
    return { paid: false, txHash: null };
  }
}
