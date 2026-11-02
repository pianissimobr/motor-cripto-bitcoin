import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { checksumAddress } from '../domain/address.js';
import { addCalendarDays } from '../domain/calendar-time.js';
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
  ValidationError,
} from '../domain/errors.js';
import { divRound } from '../domain/money.js';
import { HD_INDEX_SCOPE } from '../hd/index-scope.js';
import type { PaymentLink } from '../domain/types.js';
import type { HdWallet } from '../hd/hd-wallet.js';
import type { Logger } from '../logger.js';
import type { MotorRepositories } from '../ports/index.js';
import { buildRampLink, stripHostApiKey } from '../ramp/link-builder.js';
import type { LinkStateMachine } from './link-state-machine.js';

export type CreateLinkRequest = {
  apiClienteId: string;
  externalId: string;
  idempotencyKey?: string | null;
  amountCents: number;
  rampProfileId: string;
  walletId: string;
  finalUrl?: string | null;
  actor?: string;
  ip?: string | null;
};

export type CreateLinkResult = {
  link: PaymentLink;
  pageUrl: string;
  reused: boolean;
};

export type LinkServiceDeps = {
  repos: MotorRepositories;
  hdWallet: HdWallet;
  linkState: LinkStateMachine;
  logger: Logger;
  ttlMinutes: number;
  maxIndex: number;
  publicBaseUrl: string;
  settlement: { days: number };
};

/**
 * Criacao e consulta de links de cobranca.
 *
 * O endereco de deposito e sempre derivado no servidor. O destino do sweep
 * e uma carteira allowlisted do proprio cliente. Idempotencia:
 * `Idempotency-Key` (ou `external_id` quando o header nao vem) + hash do
 * payload; a mesma chave com payload diferente e conflito.
 */
export class LinkService {
  constructor(private readonly deps: LinkServiceDeps) {}

  async create(input: CreateLinkRequest): Promise<CreateLinkResult> {
    const { repos } = this.deps;
    const externalId = input.externalId.trim();
    if (!externalId || externalId.length > 200) {
      throw new ValidationError('externalId deve ter entre 1 e 200 caracteres');
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new ValidationError('valor deve ser um inteiro positivo em centavos');
    }
    if (input.amountCents > 100_000_000) {
      throw new ValidationError('valor acima do limite permitido');
    }

    const idempotencyKey = (input.idempotencyKey ?? externalId).trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new ValidationError('chave de idempotencia invalida');
    }
    const requestHash = hashCreateLinkRequest({
      externalId,
      amountCents: input.amountCents,
      rampProfileId: input.rampProfileId,
      walletId: input.walletId,
      finalUrl: input.finalUrl ?? null,
    });

    const existing =
      (await repos.links.findByIdempotencyKey(input.apiClienteId, idempotencyKey)) ??
      (await repos.links.findByExternalId(input.apiClienteId, externalId));
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictError(
          'chave de idempotencia ja usada com outro payload',
          'idempotencia_conflitante',
        );
      }
      return {
        link: existing,
        pageUrl: this.pageUrl(existing.pageToken),
        reused: true,
      };
    }

    const [client, profile, wallet] = await Promise.all([
      repos.apiClients.findById(input.apiClienteId),
      repos.rampProfiles.findById(input.rampProfileId),
      repos.apiClientWallets.findById(input.walletId),
    ]);
    if (!client || client.status !== 'ativo') {
      throw new NotFoundError('cliente da API nao encontrado ou inativo');
    }
    if (!profile) throw new NotFoundError('perfil Ramp nao encontrado');
    if (!wallet || wallet.apiClienteId !== input.apiClienteId) {
      throw new ValidationError('carteira de destino nao pertence ao cliente');
    }
    if (wallet.chain.toLowerCase() !== profile.chain.toLowerCase()) {
      throw new ValidationError(
        `carteira da chain "${wallet.chain}" incompativel com o perfil "${profile.chain}"`,
      );
    }

    const index = await repos.indices.allocate(HD_INDEX_SCOPE, this.deps.maxIndex);
    try {
      const enderecoDeposito = checksumAddress(this.deps.hdWallet.deriveAddress(index));
      const caminhoDerivacao = this.deps.hdWallet.fullPath(index);
      const taxa = profile.taxaTokenPorFiatBaseUnits;
      const expectedBaseUnits =
        taxa && taxa > 0n ? divRound(taxa * BigInt(input.amountCents), 100n) : null;

      const paymentId = randomUUID();
      const rampUrlCompleta = buildRampLink({
        profile,
        depositAddress: enderecoDeposito,
        amountCents: input.amountCents,
        paymentId,
        finalUrl: input.finalUrl ?? null,
      });
      const rampUrl = stripHostApiKey(rampUrlCompleta);

      const pageToken = randomBytes(32).toString('base64url');
      const now = new Date();
      const expiraEm = new Date(now.getTime() + this.deps.ttlMinutes * 60_000);
      const liquidacaoAte = addCalendarDays(expiraEm, this.deps.settlement.days);

      let link: PaymentLink;
      try {
        link = await repos.links.create({
          id: paymentId,
          apiClienteId: input.apiClienteId,
          externalId,
          idempotencyKey,
          requestHash,
          rampProfileId: profile.id,
          chain: profile.chain,
          asset: profile.asset,
          tokenContract: profile.tokenContract,
          decimals: profile.decimals,
          moedaFiat: profile.fiatCurrency,
          valorFiatCentavos: input.amountCents,
          valorFiatUnidades: input.amountCents,
          taxaTokenPorFiatBaseUnits: taxa,
          expectedBaseUnits,
          indiceHd: index,
          caminhoDerivacao,
          enderecoDeposito,
          walletAddress: wallet.address,
          pageToken,
          pageTokenHash: hashPageToken(pageToken),
          rampUrl,
          status: 'aguardando',
          expiraEm,
          liquidacaoAte,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          const concurrent =
            (await repos.links.findByIdempotencyKey(input.apiClienteId, idempotencyKey)) ??
            (await repos.links.findByExternalId(input.apiClienteId, externalId));
          if (concurrent) {
            if (concurrent.requestHash !== requestHash) {
              throw new ConflictError(
                'chave de idempotencia ja usada com outro payload',
                'idempotencia_conflitante',
              );
            }
            await repos.indices.release(HD_INDEX_SCOPE, index);
            return {
              link: concurrent,
              pageUrl: this.pageUrl(concurrent.pageToken),
              reused: true,
            };
          }
        }
        throw err;
      }

      await repos.audit.record({
        ator: input.actor ?? 'api',
        acao: 'link.criado',
        entidade: 'link',
        entidadeId: link.id,
        detalhes: {
          apiClienteId: link.apiClienteId,
          externalId,
          rampProfileId: profile.id,
          chain: profile.chain,
          valorFiatCentavos: input.amountCents,
          indiceHd: index,
          enderecoDeposito: link.enderecoDeposito,
          walletAddress: link.walletAddress,
        },
        ip: input.ip ?? null,
      });

      this.deps.logger.info(
        { linkId: link.id, apiClienteId: link.apiClienteId, indiceHd: index },
        'link de cobranca criado',
      );
      return { link, pageUrl: this.pageUrl(pageToken), reused: false };
    } catch (err) {
      await repos.indices.release(HD_INDEX_SCOPE, index).catch((releaseErr: unknown) => {
        this.deps.logger.warn(
          { err: releaseErr, indiceHd: index },
          'falha ao liberar indice HD apos erro na criacao do link',
        );
      });
      throw err;
    }
  }

  async getForClient(apiClienteId: string, linkId: string): Promise<PaymentLink> {
    const link = await this.deps.repos.links.findById(linkId);
    if (!link || link.apiClienteId !== apiClienteId) {
      throw new NotFoundError('link nao encontrado');
    }
    return link;
  }

  async listForClient(apiClienteId: string, limit = 50): Promise<PaymentLink[]> {
    return this.deps.repos.links.listByClient(apiClienteId, Math.min(Math.max(limit, 1), 200));
  }

  async list(limit = 50): Promise<PaymentLink[]> {
    return this.deps.repos.links.listAll(Math.min(Math.max(limit, 1), 200));
  }

  async getPublicByToken(token: string): Promise<PaymentLink> {
    if (!token || token.length < 16 || token.length > 200) {
      throw new NotFoundError('pagina nao encontrada');
    }
    const link = await this.deps.repos.links.findByPageTokenHash(hashPageToken(token));
    if (!link) throw new NotFoundError('pagina nao encontrada');
    return link;
  }

  async revoke(
    linkId: string,
    actor = 'admin',
    ip: string | null = null,
  ): Promise<PaymentLink> {
    const link = await this.deps.repos.links.findById(linkId);
    if (!link) throw new NotFoundError('link nao encontrado');
    if (link.status === 'nao_realizado' || link.status === 'movido') return link;
    if (link.status === 'pago' || link.status === 'pago_sem_gas') {
      throw new ConflictError(
        'link ja recebeu pagamento; nao pode ser revogado',
        'link_ja_pago',
      );
    }
    await this.deps.repos.links.updateSettlement(linkId, {
      motivoNaoRealizado: 'revogado',
    });
    await this.deps.linkState.transition({
      linkId,
      to: 'nao_realizado',
      reason: 'revogado pelo operador',
      actor,
      ip,
    });
    return (await this.deps.repos.links.findById(linkId))!;
  }

  async detail(linkId: string) {
    const { repos } = this.deps;
    const link = await repos.links.findById(linkId);
    if (!link) return null;
    const [payments, transfers, webhooks] = await Promise.all([
      repos.payments.listByLink(linkId),
      repos.transfers.findByLink(linkId),
      repos.webhooks.listByLink(linkId),
    ]);
    return { link, payments, transfers, webhooks };
  }

  pageUrl(token: string): string {
    return `${this.deps.publicBaseUrl}/p/${encodeURIComponent(token)}`;
  }
}

export function hashPageToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashCreateLinkRequest(input: {
  externalId: string;
  amountCents: number;
  rampProfileId: string;
  walletId: string;
  finalUrl?: string | null;
}): string {
  const canonical = JSON.stringify({
    externalId: input.externalId,
    amountCents: input.amountCents,
    rampProfileId: input.rampProfileId,
    walletId: input.walletId,
    finalUrl: input.finalUrl ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
