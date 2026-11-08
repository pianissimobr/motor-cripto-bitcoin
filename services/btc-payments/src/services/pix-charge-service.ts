import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { resolveSettlementDestination } from './settlement-destination.js';
import type { AppConfig } from '../config.js';
import { LuniumError, type LuniumCharge, type LuniumClient } from '../adapters/lunium/client.js';
import { verifyUsdcSettlement } from '../adapters/chain/usdc-settlement-verify.js';
import { blindIndex } from '../crypto/hmac.js';
import type { Repositories } from '../db/repositories.js';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  SettlementWalletRequiredError,
  UpstreamError,
  ValidationError,
} from '../domain/errors.js';
import {
  assertPixChargeTransition,
  canTransitionPixCharge,
  isFinalPixStatus,
  mapLuniumStatus,
} from '../domain/pix.js';
import {
  parseDecimalToMinor,
  type PixCharge,
  type SettlementChain,
  type SettlementStatus,
} from '../domain/types.js';
import type { LedgerService } from '../ledger/ledger-service.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';
import { enqueuePixChargeEvent } from './pix-events.js';
import { normalizeTaxId } from '../domain/tax-id.js';
import { stricter, type LuniumLimits } from './lunium-limits.js';

export type CreatePixChargeInput = {
  clientId: string;
  externalId: string;
  amountBrlCents: bigint;
  payerTaxNumber: string;
  payerName?: string | null;
  metadata?: Record<string, unknown> | null;
  sandboxScenario?: string | null;
  /**
   * Endereco que recebe o USDC, quando a loja esta vendendo para um cliente
   * que tem carteira no app (F4). O endereco precisa estar cadastrado pela
   * loja (com prova de posse) e nao pode estar revogado.
   */
  destinationAddress?: string | null;
};

export type PixChargeDto = {
  id: string;
  external_id: string;
  provider: 'lunium';
  provider_charge_id: string | null;
  status: PixCharge['status'];
  settlement_status: PixCharge['settlementStatus'];
  amount_brl_cents: string;
  asset: 'USDC';
  chain: SettlementChain;
  pix: {
    qr_copypaste: string | null;
    qr_image_url: string | null;
    qr_svg: string | null;
    expires_at: string | null;
  };
  payout_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type PixPublicDto = {
  id: string;
  status: PixCharge['status'];
  settlement_status: PixCharge['settlementStatus'];
  amount_brl_cents: string;
  asset: 'USDC';
  chain: SettlementChain;
  pix: {
    qr_copypaste: string | null;
    qr_image_url: string | null;
    qr_svg: string | null;
  };
  e2e: string | null;
  paid_at: string | null;
  settled_at: string | null;
  expires_at: string | null;
  error: string | null;
};

export type PixChargeServiceDeps = {
  repos: Repositories;
  /** Limites vigentes da chave na Lunium (GET /keys/me), em cache. */
  liveLimits?: Pick<LuniumLimits, 'get'>;
  /** Nao usado na liquidacao direta; mantido por compatibilidade. */
  ledger?: LedgerService;
  lunium: LuniumClient;
  config: AppConfig;
  logger: Logger;
  alerts?: AlertService;
  now?: () => Date;
};

type PixChargeUpdate = Parameters<Repositories['updatePixCharge']>[0];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export function normalizePayerTax(value: string): string {
  const taxId = normalizeTaxId(value);
  if (!taxId) {
    throw new ValidationError(
      'payer_tax_number nao e um CPF ou CNPJ valido (confira os digitos)',
    );
  }
  return taxId.value;
}

function isUncertainProviderError(err: unknown): boolean {
  if (!(err instanceof LuniumError)) return true;
  return err.statusCode === 429 || err.statusCode >= 500;
}

/**
 * Quantidade de USDC que **chega na carteira** do cliente.
 *
 * Medido na primeira entrega real (2026-11-03): a Lunium nao manda `asset_amount`
 * nesse fluxo. O valor entregue vem em `delivery_accounting.aSacar` (1.55802042
 * para R$ 10,00); o `usdt_amount` (1.5820698) e o que foi *comprado* no
 * mercado, antes da taxa de saque da rede (0.018) — usar esse numero como
 * minima da verificacao on-chain reprovaria uma entrega valida.
 *
 * A comparacao on-chain e em unidades minimas do token (6 casas): o
 * `aSacar` tem 8 casas e truncado bate com o `Transfer` da rede.
 */
/** Primeiro valor inteiro presente na lista (o fallback local vem por ultimo). */
function firstNumber(
  ...values: Array<number | null | undefined | bigint | null>
): bigint | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'bigint') return value;
    if (Number.isFinite(value)) return BigInt(Math.trunc(value));
  }
  return null;
}

export function deliveredAmountMinor(
  charge: LuniumCharge,
  current: bigint | null,
): bigint | null {
  const candidates = [
    charge.asset_amount,
    charge.delivery_accounting?.aSacar,
    // No sandbox so vem o campo legado.
    charge.sandbox ? charge.usdt_amount : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
    try {
      const parsed = parseDecimalToMinor(candidate, 6);
      if (parsed > 0n) return parsed;
    } catch {
      // Valor inesperado: tenta o proximo candidato.
    }
  }
  return current;
}

function settlementStatusFor(mapped: PixCharge['status']): SettlementStatus {
  if (mapped === 'pago') return 'aguardando_confirmacao';
  if (mapped === 'liquidado') return 'pago';
  if (mapped === 'manual') return 'manual';
  if (mapped === 'falhou' || mapped === 'incerto') return 'falhou';
  return 'nao_iniciado';
}

export class PixChargeService {
  constructor(private readonly deps: PixChargeServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async toDto(charge: PixCharge): Promise<PixChargeDto> {
    let qrSvg: string | null = null;
    if (!charge.qrImageUrl && charge.qrCopypaste) {
      try {
        qrSvg = await QRCode.toString(charge.qrCopypaste, {
          type: 'svg',
          margin: 1,
          width: 256,
        });
      } catch (err) {
        this.deps.logger.warn(
          { err, pixChargeId: charge.id },
          'falha ao gerar QR PIX local',
        );
      }
    }
    return {
      id: charge.id,
      external_id: charge.externalId,
      provider: charge.provider,
      provider_charge_id: charge.providerChargeId,
      status: charge.status,
      settlement_status: charge.settlementStatus,
      amount_brl_cents: charge.amountBrlCents.toString(),
      asset: charge.asset,
      chain: charge.chain,
      pix: {
        qr_copypaste: charge.qrCopypaste,
        qr_image_url: charge.qrImageUrl,
        qr_svg: qrSvg,
        expires_at: iso(charge.expiresAt),
      },
      payout_id: charge.payoutId,
      error: charge.error,
      created_at: charge.createdAt.toISOString(),
      updated_at: charge.updatedAt.toISOString(),
    };
  }

  async create(
    input: CreatePixChargeInput,
  ): Promise<{ dto: PixChargeDto; reused: boolean }> {
    if (!this.deps.config.pix.enabled) {
      throw new ServiceUnavailableError('PIX desabilitado');
    }
    // Configuracao e limite vigente da chave na Lunium: vale o mais restrito.
    const range = stricter(
      { min: this.deps.config.pix.minBrlCents, max: this.deps.config.pix.maxBrlCents },
      (await this.deps.liveLimits?.get())?.cashin,
    );
    if (input.amountBrlCents < range.min) {
      throw new ValidationError(`valor abaixo do minimo (${range.min.toString()} centavos)`);
    }
    if (input.amountBrlCents > range.max) {
      throw new ValidationError(`valor acima do maximo (${range.max.toString()} centavos)`);
    }

    const payerTax = normalizePayerTax(input.payerTaxNumber);
    const payerTaxHash = blindIndex(
      this.deps.config.crypto.payerTaxBlindKey,
      payerTax,
    );
    const payerTaxLast4 = payerTax.slice(-4);

    const existing = await this.deps.repos.findPixChargeByClientAndExternalId(
      input.clientId,
      input.externalId,
    );
    if (existing) {
      if (
        existing.amountBrlCents !== input.amountBrlCents ||
        existing.payerTaxHash !== payerTaxHash
      ) {
        throw new ConflictError('external_id ja usado com dados diferentes');
      }
      return { dto: await this.toDto(existing), reused: true };
    }

    // A Lunium entrega o USDC direto na carteira de quem recebe. Sem ela nao
    // ha para onde liquidar, entao a cobranca nem e criada.
    //
    // O destino tem duas fontes (D18/D22): o `settlement_address` do
    // cliente (perfil `usuario`, a carteira criada no app) ou a carteira
    // `usdc_settlement` da loja (perfil `loja`).
    const destination = await this.resolveDestinationAddress(
      input.clientId,
      input.destinationAddress ?? null,
    );
    if (!destination) throw new SettlementWalletRequiredError();

    try {
      const limits = await this.deps.lunium.getLimits(payerTax);
      if (
        typeof limits.max_amount_cents === 'number' &&
        input.amountBrlCents > BigInt(limits.max_amount_cents)
      ) {
        throw new ValidationError('valor acima do limite atual do pagador');
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      this.deps.logger.warn(
        { err, externalId: input.externalId },
        'nao foi possivel consultar limites da Lunium; criacao vai revalidar',
      );
    }

    const id = randomUUID();
    const providerExternalId = `pix_${id}`;
    const created = await this.deps.repos.createPixCharge({
      id,
      clientId: input.clientId,
      externalId: input.externalId,
      providerExternalId,
      amountBrlCents: input.amountBrlCents,
      // A chain precisa ser a mesma que a Lunium vai liquidar: a verificacao
      // on-chain procura a entrega nesta rede.
      chain: this.deps.config.pix.chain,
      destinationAddress: destination,
      payerTaxHash,
      payerTaxLast4,
      metadata: input.metadata ?? null,
    });

    try {
      const isSandbox =
        this.deps.config.pix.luniumApiKey?.startsWith('lun_test_') ?? false;
      const charge = await this.deps.lunium.createCharge({
        amountCents: input.amountBrlCents,
        payerTaxNumber: payerTax,
        ...(input.payerName ? { payerName: input.payerName } : {}),
        externalId: providerExternalId,
        customerRef: input.clientId,
        asset: this.deps.config.pix.asset,
        chain: this.deps.config.pix.chain,
        payoutAddress: destination,
        ...(isSandbox && input.sandboxScenario
          ? { sandboxScenario: input.sandboxScenario }
          : {}),
      });
      const updated = await this.applyProviderCharge(created, charge);
      await enqueuePixChargeEvent(
        { repos: this.deps.repos, now: () => this.now() },
        updated,
        'pix_charge.created',
        'created',
      );
      await this.deps.repos.insertAuditEvent({
        actor: 'api',
        action: 'pix_charge.created',
        entity: 'pix_charge',
        entityId: created.id,
        metadata: {
          externalId: created.externalId,
          amountBrlCents: created.amountBrlCents.toString(),
          providerChargeId: charge.cashin_id,
        },
      });
      return { dto: await this.toDto(updated), reused: false };
    } catch (err) {
      const message = errorMessage(err);
      const uncertain = isUncertainProviderError(err);
      const pending = await this.deps.repos.updatePixCharge({
        id: created.id,
        status: uncertain ? 'incerto' : 'falhou',
        settlementStatus: uncertain ? 'manual' : 'falhou',
        error: message,
        attempts: created.attempts + 1,
        lastCheckedAt: this.now(),
      });
      if (uncertain) {
        await this.deps.alerts?.send({
          level: 'error',
          title: 'criacao de PIX incerta',
          message: message,
          metadata: { pixChargeId: created.id, externalId: created.externalId },
        });
      }
      this.deps.logger.error(
        { err, pixChargeId: created.id, externalId: created.externalId },
        'falha ao criar cobranca PIX',
      );
      if (pending) {
        await enqueuePixChargeEvent(
          { repos: this.deps.repos, now: () => this.now() },
          pending,
          'pix_charge.failed',
          'create_failed',
        );
      }
      throw new UpstreamError('falha ao criar cobranca PIX', {
        details: { pix_charge_id: created.id, external_id: created.externalId },
        cause: err,
      });
    }
  }

  async getById(clientId: string, id: string): Promise<PixChargeDto> {
    const charge = await this.deps.repos.findPixChargeByIdForClient(id, clientId);
    if (!charge) throw new NotFoundError('cobranca PIX nao encontrada');
    return this.toDto(charge);
  }

  async getByExternalId(
    clientId: string,
    externalId: string,
  ): Promise<PixChargeDto> {
    const charge = await this.deps.repos.findPixChargeByClientAndExternalId(
      clientId,
      externalId,
    );
    if (!charge) throw new NotFoundError('cobranca PIX nao encontrada');
    return this.toDto(charge);
  }

  /**
   * Visao publica da cobranca (checkout).
   *
   * Nao expoe `client_id` nem dado do lojista: o pagador nao tem conta. O
   * estado e atualizado junto com o provedor, mas no maximo uma vez a cada
   * 10 s — a pagina de checkout consulta a cada 5 s e a Lunium aceita 60
   * requisicoes por minuto no total.
   */
  async getPublicById(id: string): Promise<PixPublicDto> {
    let charge = await this.deps.repos.findPixChargeById(id);
    if (!charge) throw new NotFoundError('cobranca PIX nao encontrada');
    const lastChecked = charge.lastCheckedAt?.getTime() ?? 0;
    const stale = Date.now() - lastChecked > 10_000;
    if (stale && !isFinalPixStatus(charge.status)) {
      try {
        const providerCharge = await this.fetchProviderCharge(charge);
        if (providerCharge) {
          charge = await this.applyProviderCharge(charge, providerCharge);
        }
      } catch (err) {
        this.deps.logger.warn(
          { err, pixChargeId: charge.id },
          'falha ao atualizar status publico da cobranca PIX',
        );
      }
    }
    let qrSvg: string | null = null;
    if (!charge.qrImageUrl && charge.qrCopypaste) {
      try {
        qrSvg = await QRCode.toString(charge.qrCopypaste, {
          type: 'svg',
          margin: 1,
          width: 256,
        });
      } catch {
        qrSvg = null;
      }
    }
    return {
      id: charge.id,
      status: charge.status,
      settlement_status: charge.settlementStatus,
      amount_brl_cents: charge.amountBrlCents.toString(),
      asset: charge.asset,
      chain: charge.chain,
      pix: {
        qr_copypaste: charge.qrCopypaste,
        qr_image_url: charge.qrImageUrl,
        qr_svg: qrSvg,
      },
      e2e: charge.e2e,
      paid_at: charge.paidAt?.toISOString() ?? null,
      settled_at: charge.settledAt?.toISOString() ?? null,
      expires_at: charge.expiresAt?.toISOString() ?? null,
      error: charge.error,
    };
  }

  async listForMerchant(clientId: string, limit: number): Promise<PixChargeDto[]> {
    const charges = await this.deps.repos.listPixChargesForMerchant(
      clientId,
      limit,
    );
    return Promise.all(charges.map((charge) => this.toDto(charge)));
  }

  async list(limit: number): Promise<PixChargeDto[]> {
    const charges = await this.deps.repos.listPixCharges(limit);
    return Promise.all(charges.map((charge) => this.toDto(charge)));
  }

  async sync(id: string): Promise<PixChargeDto> {
    const local = await this.deps.repos.findPixChargeById(id);
    if (!local) throw new NotFoundError('cobranca PIX nao encontrada');

    const providerCharge = await this.fetchProviderCharge(local);
    if (!providerCharge) return this.toDto(local);
    return this.toDto(await this.applyProviderCharge(local, providerCharge));
  }

  async reconcile(limit: number): Promise<{
    checked: number;
    synced: number;
    errors: number;
    skipped?: boolean;
  }> {
    // A Lunium recusou por limite: o limitador esta em cooldown. Reconciliar
    // agora so gastaria a fila e pioraria a situacao; o proximo ciclo tenta
    // de novo.
    const cooldown = this.deps.lunium.rateLimiter?.cooldownRemaining() ?? 0;
    if (cooldown > 0) {
      this.deps.logger.warn(
        { cooldownMs: cooldown },
        'reconciliacao PIX adiada: limite da Lunium em cooldown',
      );
      return { checked: 0, synced: 0, errors: 0, skipped: true };
    }

    // Feed de eventos: 1 chamada diz o que mudou. As que mudaram sincronizam
    // ja; as demais em aberto, so na varredura (a cada pixSweepMs). Sem o
    // feed, consulta todas como antes.
    const changed = await this.changedRefsFromFeed();
    const now = this.now().getTime();
    const sweepMs = this.deps.config.jobs.pixSweepMs;
    const fromFeed = changed ? await this.deps.repos.listOpenPixChargesByProviderRefs([...changed]) : [];
    const swept = (await this.deps.repos.listPixChargesToReconcile(limit)).filter(
      (charge) =>
        !changed ||
        charge.status === 'criando' ||
        charge.status === 'incerto' ||
        !charge.lastCheckedAt ||
        now - charge.lastCheckedAt.getTime() >= sweepMs,
    );
    const seen = new Set<string>();
    const charges = [...fromFeed, ...swept].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    let synced = 0;
    let errors = 0;
    for (const charge of charges) {
      try {
        await this.sync(charge.id);
        synced++;
      } catch (err) {
        errors++;
        this.deps.logger.error(
          { err, pixChargeId: charge.id },
          'erro ao reconciliar cobranca PIX',
        );
      }
    }
    return { checked: charges.length, synced, errors };
  }

  /** Ultimo evento do feed ja visto (em memoria; reiniciar so revarre). */
  private lastFeedTs: string | null = null;

  /**
   * Referencias de cash-in que mudaram desde o ultimo ciclo, pelo feed de
   * eventos da Lunium. `null` quando o feed falhou (o reconcile volta a
   * consultar cada cobranca).
   */
  private async changedRefsFromFeed(): Promise<Set<string> | null> {
    if (!this.deps.lunium.getEvents) return null;
    try {
      const feed = await this.deps.lunium.getEvents(200);
      const refs = new Set<string>();
      let newest = this.lastFeedTs;
      for (const event of feed.eventos ?? []) {
        if (event.fluxo !== 'cashin' || !event.ref) continue;
        if (this.lastFeedTs && event.ts <= this.lastFeedTs) continue;
        refs.add(event.ref);
        if (!newest || event.ts > newest) newest = event.ts;
      }
      this.lastFeedTs = newest;
      return refs;
    } catch (err) {
      this.deps.logger.warn({ err }, 'feed de eventos da Lunium indisponivel; consultando cada cobranca');
      return null;
    }
  }

  /**
   * Endereco que recebe o USDC do cash-in.
   *
   * `usuario` (perfil pessoal do app): o `settlement_address` do cliente.
   * `loja`: a carteira `usdc_settlement` da propria loja ou, quando a loja
   * esta vendendo para um cliente com carteira no app (F4), o endereco
   * cadastrado pela loja — que precisa estar registrado e nao revogado.
   */
  private async resolveDestinationAddress(
    clientId: string,
    explicit: string | null,
  ): Promise<string | null> {
    return resolveSettlementDestination({
      repos: this.deps.repos,
      config: this.deps.config,
      clientId,
      explicit,
    });
  }

  async applyProviderCharge(
    local: PixCharge,
    charge: LuniumCharge,
  ): Promise<PixCharge> {
    const providerStatus = charge.status;
    const providerSettlement = charge.settlement_status;
    const mapped = mapLuniumStatus(providerStatus, providerSettlement);

    if (isFinalPixStatus(local.status) && mapped !== local.status) {
      return local;
    }

    const baseUpdate: PixChargeUpdate = {
      id: local.id,
      providerChargeId: local.providerChargeId ?? charge.cashin_id,
      providerStatus,
      providerSettlementStatus: providerSettlement,
      qrCopypaste: charge.qr_copypaste ?? local.qrCopypaste,
      qrImageUrl: charge.qr_image_url ?? local.qrImageUrl,
      expiresAt: charge.expires_at ? new Date(charge.expires_at) : local.expiresAt,
      paidAt: charge.paid_at ? new Date(charge.paid_at) : local.paidAt,
      settledAt: charge.settled_at ? new Date(charge.settled_at) : local.settledAt,
      e2e: charge.e2e ?? local.e2e,
      payerName: charge.payer_name ?? local.payerName,
      feeLuniumBps: charge.lunium_fee_bps ?? local.feeLuniumBps,
      feeLuniumFixedCents:
        charge.lunium_fee_fixed_cents !== undefined &&
        charge.lunium_fee_fixed_cents !== null
          ? BigInt(charge.lunium_fee_fixed_cents)
          : local.feeLuniumFixedCents,
      feePartnerBps: charge.partner_fee_bps ?? local.feePartnerBps,
      // Medido na entrega real: no cash-in as taxas vem dentro de
      // `delivery_accounting`, nao no topo da resposta.
      feeTotalCents: firstNumber(
        charge.fee_total_cents,
        charge.delivery_accounting?.fee_total_cents,
        local.feeTotalCents,
      ),
      netCents: firstNumber(
        charge.net_cents,
        charge.delivery_accounting?.net_cents,
        local.netCents,
      ),
      assetAmountMinor: deliveredAmountMinor(charge, local.assetAmountMinor),
      withdrawFee: charge.withdraw_fee ?? local.withdrawFee,
      settlementTxHash: charge.settlement_tx_hash ?? local.settlementTxHash,
      settlementTxUrl: charge.settlement_tx_url ?? local.settlementTxUrl,
      providerPayload: charge as Record<string, unknown>,
      error: charge.error ?? null,
      lastCheckedAt: this.now(),
    };

    if (local.status === 'liquidado' && mapped !== 'liquidado') {
      const manual = await this.deps.repos.updatePixCharge({
        ...baseUpdate,
        status: 'manual',
        settlementStatus: 'manual',
        error: `status ${mapped} recebido apos liquidacao`,
      });
      if (!manual) throw new Error('falha ao atualizar cobranca PIX');
      await this.deps.alerts?.send({
        level: 'error',
        title: 'PIX liquidado com status posterior',
        message: `status ${mapped} recebido apos liquidacao`,
        metadata: { pixChargeId: local.id },
      });
      return manual;
    }

    if (mapped === 'liquidado') {
      return this.settle(local, baseUpdate);
    }

    const canMove = mapped !== local.status;
    if (canMove && !canTransitionPixCharge(local.status, mapped)) {
      this.deps.logger.warn(
        { pixChargeId: local.id, from: local.status, to: mapped },
        'status PIX fora de ordem; mantendo estado local',
      );
      return local;
    }
    if (canMove) assertPixChargeTransition(local.status, mapped);

    const updated = await this.deps.repos.updatePixCharge({
      ...baseUpdate,
      status: canMove ? mapped : local.status,
      settlementStatus: settlementStatusFor(mapped),
    });
    if (!updated) throw new Error('falha ao atualizar cobranca PIX');

    if (canMove) {
      if (mapped === 'manual') {
        // A Lunium esta em conferencia (divergencia de documento do pagador,
        // por exemplo): o Pix pode ter sido pago e nao entrega. O dinheiro esta
        // no provedor e a entrega nao vem sozinha — o time precisa decidir.
        await this.deps.alerts?.send({
          level: 'warn',
          title: 'cobranca PIX em conferencia na Lunium',
          message: `provider=${providerStatus ?? 'desconhecido'} settlement=${providerSettlement ?? 'desconhecido'}`,
          metadata: {
            pixChargeId: local.id,
            externalId: local.externalId,
            providerChargeId: charge.cashin_id,
          },
        });
      }
      const eventType =
        mapped === 'pago'
          ? 'pix_charge.paid'
          : mapped === 'expirado'
            ? 'pix_charge.expired'
            : mapped === 'reembolsado'
              ? 'pix_charge.refunded'
              : mapped === 'falhou'
                ? 'pix_charge.failed'
                : null;
      if (eventType) {
        await enqueuePixChargeEvent(
          { repos: this.deps.repos, now: () => this.now() },
          updated,
          eventType,
          mapped,
        );
      }
    }

    return updated;
  }

  private async fetchProviderCharge(local: PixCharge): Promise<LuniumCharge | null> {
    if (local.providerChargeId) {
      return this.deps.lunium.getCharge(local.providerChargeId);
    }
    const found = await this.deps.lunium.findChargesByExternalId(
      local.providerExternalId,
    );
    return found[0] ?? null;
  }

  private async verifySettlement(
    local: PixCharge,
    update: PixChargeUpdate,
  ): Promise<'ok' | 'pending' | 'invalid'> {
    if (!this.deps.config.pix.verifySettlementTx) return 'ok';
    if (!update.settlementTxHash) return 'pending';
    if (!local.destinationAddress) return 'invalid';
    const result = await verifyUsdcSettlement({
      rpcUrls: this.deps.config.settlement.rpcUrls,
      chainId: this.deps.config.settlement.chainId,
      usdcAddresses: this.deps.config.settlement.usdcAddresses,
      chainLabel: this.deps.config.settlement.chain,
      txHash: update.settlementTxHash,
      recipient: local.destinationAddress,
      minAmountMinor: update.assetAmountMinor ?? 0n,
      timeoutMs: this.deps.config.pix.timeoutMs,
      minConfirmations: this.deps.config.settlement.confirmations,
    });
    if (result.kind === 'ok') return 'ok';
    this.deps.logger.warn(
      {
        pixChargeId: local.id,
        txHash: update.settlementTxHash,
        kind: result.kind,
        detail: result.detail,
      },
      'verificacao on-chain da liquidacao PIX',
    );
    return result.kind;
  }

  private async settle(
    local: PixCharge,
    update: PixChargeUpdate,
  ): Promise<PixCharge> {
    if (!update.assetAmountMinor || update.assetAmountMinor <= 0n) {
      const manual = await this.deps.repos.updatePixCharge({
        ...update,
        status: 'manual',
        settlementStatus: 'manual',
        error: 'settlement sem asset_amount valido',
      });
      if (!manual) throw new Error('falha ao atualizar cobranca PIX');
      await this.deps.alerts?.send({
        level: 'error',
        title: 'PIX liquidado sem valor USDC',
        metadata: { pixChargeId: local.id },
      });
      return manual;
    }

    const verification = await this.verifySettlement(local, update);
    if (verification === 'invalid') {
      const manual = await this.deps.repos.updatePixCharge({
        ...update,
        status: 'manual',
        settlementStatus: 'manual',
        error: 'liquidacao PIX nao confere on-chain com a carteira do lojista',
      });
      if (!manual) throw new Error('falha ao atualizar cobranca PIX');
      await this.deps.alerts?.send({
        level: 'error',
        title: 'liquidacao PIX nao confere on-chain com a carteira do lojista',
        metadata: {
          pixChargeId: local.id,
          txHash: update.settlementTxHash,
        },
      });
      return manual;
    }
    if (verification === 'pending') {
      const deferred = await this.deps.repos.updatePixCharge({
        ...update,
        status: local.status,
        settlementStatus:
          local.status === 'liquidado'
            ? local.settlementStatus
            : 'aguardando_confirmacao',
        error: 'aguardando confirmacao on-chain da liquidacao',
      });
      return deferred ?? local;
    }

    // O USDC foi direto da Lunium para a carteira do lojista: a plataforma
    // nao custodia esse valor, entao nao ha lancamento no ledger nem payout.
    if (local.status !== 'liquidado') {
      assertPixChargeTransition(local.status, 'liquidado');
    }
    const updated = await this.deps.repos.updatePixCharge({
      ...update,
      status: 'liquidado',
      settlementStatus: 'pago',
      settledAt: update.settledAt ?? this.now(),
      error: null,
    });
    if (!updated) throw new Error('falha ao liquidar cobranca PIX');

    await enqueuePixChargeEvent(
      { repos: this.deps.repos, now: () => this.now() },
      updated,
      'pix_charge.settled',
      'settled',
    );
    return updated;
  }
}
