import QRCode from 'qrcode';
import type { AppConfig } from '../config.js';
import { deriveAddress, type AccountXpub } from '../adapters/hd/derivation.js';
import type { LnbitsClient } from '../adapters/lnbits/client.js';
import type { Repositories } from '../db/repositories.js';
import { buildBip21, buildLnbitsWebhookUrl } from '../domain/bip21.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from '../domain/errors.js';
import { resolvePaidSats } from '../domain/lightning-amount.js';
import { satsToBtc } from '../domain/money.js';
import type { AlertService } from './alert-service.js';
import type {
  HdAddress,
  PaidRail,
  PaymentIntent,
  PaymentIntentStatus,
} from '../domain/types.js';
import type { Logger } from '../logger.js';
import { enqueueIntentEvent } from './intent-events.js';

export type CreatePaymentIntentInput = {
  clientId: string;
  externalId: string;
  amountSats: bigint;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  expiresInSeconds?: number;
};

export type PaymentIntentLightningDto = {
  invoice: string;
  payment_hash: string;
  expires_at: string | null;
};

export type PaymentIntentOnchainDto = {
  address: string;
  amount_btc: string;
  bip21: string;
};

export type PaymentIntentDto = {
  id: string;
  external_id: string;
  status: PaymentIntentStatus;
  amount_sats: string;
  description: string | null;
  expires_at: string;
  grace_until: string;
  paid_at: string | null;
  paid_rail: PaidRail | null;
  paid_amount_sats: string | null;
  overpaid_sats: string | null;
  lightning: PaymentIntentLightningDto | null;
  onchain: PaymentIntentOnchainDto | null;
  payment_uri: string | null;
  qr_svg: string | null;
  created_at: string;
  updated_at: string;
};

export type CreatedPaymentIntent = {
  dto: PaymentIntentDto;
  reused: boolean;
};

export type LightningWebhookResult = {
  status: 'pago' | 'ignorado' | 'ja_processado' | 'desconhecido';
  valor?: string;
  id_transacao?: string;
};

export type PaymentIntentServiceDeps = {
  repos: Repositories;
  lnbits: LnbitsClient;
  config: AppConfig;
  xpub: AccountXpub;
  logger: Logger;
  alerts?: AlertService;
  now?: () => Date;
};

export class PaymentIntentService {
  constructor(private readonly deps: PaymentIntentServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async create(input: CreatePaymentIntentInput): Promise<CreatedPaymentIntent> {
    const ttl = input.expiresInSeconds ?? this.deps.config.lightning.ttlSeconds;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86_400) {
      throw new ValidationError('expires_in_seconds deve estar entre 30 e 86400');
    }

    const existing = await this.deps.repos.findIntentByClientAndExternalId(
      input.clientId,
      input.externalId,
    );
    if (existing) return this.handleExisting(existing, input.amountSats);

    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    const graceUntil = new Date(
      expiresAt.getTime() + this.deps.config.onchain.graceSeconds * 1000,
    );
    const description = input.description?.trim() || null;
    const metadata = input.metadata ?? null;

    let created;
    try {
      created = await this.deps.repos.createIntentWithAddress({
        clientId: input.clientId,
        externalId: input.externalId,
        amountSats: input.amountSats,
        description,
        metadata,
        expiresAt,
        graceUntil,
        maxIndex: this.deps.config.btc.maxIndex,
        deriveAddress: (index) => {
          const derived = deriveAddress(
            this.deps.xpub,
            index,
            this.deps.config.btc.network,
            this.deps.config.btc.derivationPrefix,
          );
          return {
            address: derived.address,
            derivationPath: derived.path,
          };
        },
      });
    } catch (err) {
      const raced = await this.deps.repos.findIntentByClientAndExternalId(
        input.clientId,
        input.externalId,
      );
      if (raced) return this.handleExisting(raced, input.amountSats);
      this.deps.logger.error(
        { err, externalId: input.externalId },
        'falha ao criar intent no banco',
      );
      throw new AppError('falha ao criar cobranca', {
        code: 'intent_create_failed',
        statusCode: 500,
        expose: false,
        cause: err,
      });
    }

    const memo = (description ?? `Pedido ${input.externalId}`).slice(0, 200);
    const webhookUrl = buildLnbitsWebhookUrl(
      this.deps.config.lightning.webhookBaseUrl,
      this.deps.config.lightning.webhookToken,
    );

    try {
      const invoice = await this.deps.lnbits.createInvoice({
        amountSats: input.amountSats,
        memo,
        expiry: ttl,
        webhook: webhookUrl,
      });
      const updated = await this.deps.repos.setLightningInvoice({
        intentId: created.intent.id,
        paymentHash: invoice.payment_hash,
        invoice: invoice.payment_request,
        lightningExpiresAt: expiresAt,
        amountSats: input.amountSats,
      });
      await this.deps.repos.insertAuditEvent({
        actor: 'api',
        action: 'intent.created',
        entity: 'payment_intent',
        entityId: updated.id,
        metadata: {
          externalId: updated.externalId,
          amountSats: updated.amountSats.toString(),
        },
      });
      this.deps.logger.info(
        { intentId: updated.id, externalId: updated.externalId, amountSats: updated.amountSats.toString() },
        'cobranca criada',
      );
      return { dto: await this.toDto(updated), reused: false };
    } catch (err) {
      await this.deps.repos
        .markCreationFailed(created.intent.id, created.address.id)
        .catch((markErr) => {
          this.deps.logger.error(
            { err: markErr, intentId: created.intent.id },
            'falha ao marcar intent como falha_criacao',
          );
        });
      this.deps.logger.error(
        { err, intentId: created.intent.id, externalId: created.intent.externalId },
        'falha ao criar invoice Lightning; intent marcada como falha_criacao',
      );
      throw new UpstreamError('falha ao criar invoice Lightning', { cause: err });
    }
  }

  async getById(clientId: string, id: string): Promise<PaymentIntentDto> {
    const intent = await this.deps.repos.findIntentByIdForClient(id, clientId);
    if (!intent) throw new NotFoundError('cobranca nao encontrada');
    return this.toDto(intent);
  }

  async getByExternalId(
    clientId: string,
    externalId: string,
  ): Promise<PaymentIntentDto> {
    const intent = await this.deps.repos.findIntentByClientAndExternalId(
      clientId,
      externalId,
    );
    if (!intent) throw new NotFoundError('cobranca nao encontrada');
    return this.toDto(intent);
  }

  async cancel(clientId: string, id: string): Promise<PaymentIntentDto> {
    const intent = await this.deps.repos.findIntentByIdForClient(id, clientId);
    if (!intent) throw new NotFoundError('cobranca nao encontrada');
    if (intent.status !== 'pendente') {
      throw new ConflictError(
        `cobranca nao pode ser cancelada no status '${intent.status}'`,
      );
    }
    const updated = await this.deps.repos.markIntentCanceled(id);
    if (!updated) throw new ConflictError('cobranca mudou de estado; tente novamente');
    await this.enqueueEvent(updated, 'payment_intent.canceled', 'canceled');
    await this.deps.repos.insertAuditEvent({
      actor: 'api',
      action: 'intent.canceled',
      entity: 'payment_intent',
      entityId: updated.id,
      metadata: { externalId: updated.externalId },
    });
    return this.toDto(updated);
  }

  /**
   * Verifica a fonte oficial (LNbits) e, se pago, transiciona a intent.
   * Usado pelo webhook de entrada e pelo job de conciliacao.
   */
  async applyLightningPayment(
    paymentHash: string,
  ): Promise<LightningWebhookResult> {
    const intent = await this.deps.repos.findIntentByLightningPaymentHash(
      paymentHash,
    );
    if (!intent) return { status: 'desconhecido' };
    if (intent.status === 'falha_criacao') {
      return { status: 'ja_processado', id_transacao: intent.externalId };
    }

    const payment = await this.deps.lnbits.getPayment(paymentHash);
    if (!payment.paid) return { status: 'ignorado' };

    const resolved = resolvePaidSats({
      invoiceSats: intent.amountSats,
      ...(payment.amount_msat !== undefined
        ? { rawAmount: payment.amount_msat }
        : {}),
      ...(payment.amount_sats !== undefined
        ? { dividedSats: payment.amount_sats }
        : {}),
    });
    if (!resolved || resolved.sats < intent.amountSats) {
      const noted = await this.deps.repos.noteLightningMismatch(paymentHash, {
        rawAmount: payment.amount_msat ?? null,
        dividedSats: payment.amount_sats ?? null,
        invoiceSats: intent.amountSats.toString(),
      });
      if (noted) {
        this.deps.logger.warn(
          { intentId: intent.id, paymentHash },
          'valor Lightning nao confere com a invoice',
        );
        await this.deps.repos.insertAuditEvent({
          actor: 'lnbits',
          action: 'intent.lightning_amount_mismatch',
          entity: 'payment_intent',
          entityId: intent.id,
          metadata: {
            externalId: intent.externalId,
            paymentHash,
            invoiceSats: intent.amountSats.toString(),
          },
        });
        await this.deps.alerts?.send({
          level: 'warn',
          title: 'valor Lightning nao confere com a invoice',
          metadata: {
            intentId: intent.id,
            externalId: intent.externalId,
            invoiceSats: intent.amountSats.toString(),
          },
        });
      }
      return { status: 'ignorado', id_transacao: intent.externalId };
    }

    const paidAmount = resolved.sats;
    const lightningRaw = {
      unit: resolved.unit,
      amount_msat: payment.amount_msat ?? null,
      amount_sats: payment.amount_sats ?? null,
    };

    if (intent.status === 'cancelado') {
      const noted = await this.deps.repos.noteLightningMismatch(paymentHash, {
        kind: 'lightning_apos_cancelamento',
        invoiceSats: intent.amountSats.toString(),
      });
      if (noted) {
        await this.deps.repos.insertAuditEvent({
          actor: 'lnbits',
          action: 'intent.lightning_after_cancel',
          entity: 'payment_intent',
          entityId: intent.id,
          metadata: { externalId: intent.externalId, paymentHash },
        });
        await this.deps.alerts?.send({
          level: 'warn',
          title: 'Lightning pago em cobranca cancelada',
          metadata: { intentId: intent.id, externalId: intent.externalId },
        });
      }
      return { status: 'ignorado', id_transacao: intent.externalId };
    }

    if (intent.status === 'pago' || intent.status === 'pago_tardio') {
      if (intent.paidRail === 'onchain') {
        const updated = await this.deps.repos.addLightningToOnchainPaidIntent({
          intentId: intent.id,
          lightningSats: paidAmount,
          paymentHash,
          paidAt: this.now(),
          raw: lightningRaw,
        });
        if (updated) {
          this.deps.logger.warn(
            { intentId: intent.id, externalId: intent.externalId },
            'pagamento duplicado: on-chain e Lightning',
          );
          await this.deps.repos.insertAuditEvent({
            actor: 'lnbits',
            action: 'intent.double_paid',
            entity: 'payment_intent',
            entityId: intent.id,
            metadata: { externalId: intent.externalId, paymentHash },
          });
          await this.deps.alerts?.send({
            level: 'critical',
            title: 'pagamento duplicado (on-chain + Lightning)',
            metadata: { intentId: intent.id, externalId: intent.externalId },
          });
        }
      }
      return {
        status: 'ja_processado',
        ...(intent.paidAmountSats
          ? { valor: intent.paidAmountSats.toString() }
          : {}),
        id_transacao: intent.externalId,
      };
    }

    const status: 'pago' | 'pago_tardio' =
      intent.status === 'expirado' ||
      intent.status === 'parcial' ||
      this.now().getTime() > intent.expiresAt.getTime()
        ? 'pago_tardio'
        : 'pago';
    const paidRail: PaidRail = 'lightning';
    const overpaidSats = 0n;

    const updated = await this.deps.repos.markIntentPaid({
      intentId: intent.id,
      status,
      paidRail,
      paidAmountSats: paidAmount,
      overpaidSats,
      paidAt: this.now(),
      lightningPaymentHash: paymentHash,
      lightningRaw,
    });
    if (!updated) {
      return {
        status: 'ja_processado',
        valor: paidAmount.toString(),
        id_transacao: intent.externalId,
      };
    }

    await this.enqueueEvent(
      updated,
      updated.status === 'pago_tardio'
        ? 'payment_intent.paid_late'
        : 'payment_intent.paid',
      'paid',
    );
    await this.deps.repos.insertAuditEvent({
      actor: 'lnbits',
      action: 'intent.paid_lightning',
      entity: 'payment_intent',
      entityId: updated.id,
      metadata: {
        externalId: updated.externalId,
        paymentHash,
        paidAmountSats: paidAmount.toString(),
      },
    });
    this.deps.logger.info(
      { intentId: updated.id, externalId: updated.externalId, paidAmountSats: paidAmount.toString() },
      'pagamento Lightning confirmado',
    );

    return {
      status: 'pago',
      valor: paidAmount.toString(),
      id_transacao: updated.externalId,
    };
  }

  async reconcilePendingLightning(limit: number): Promise<{
    checked: number;
    paid: number;
    errors: number;
  }> {
    const intents = await this.deps.repos.listPendingLightningIntents(limit);
    let paid = 0;
    let errors = 0;
    for (const intent of intents) {
      if (!intent.lightningPaymentHash) continue;
      try {
        const result = await this.applyLightningPayment(
          intent.lightningPaymentHash,
        );
        if (result.status === 'pago') paid++;
      } catch (err) {
        errors++;
        this.deps.logger.error(
          { err, intentId: intent.id },
          'erro ao conciliar pagamento Lightning',
        );
      }
    }
    return { checked: intents.length, paid, errors };
  }

  async expireDueIntents(limit: number): Promise<{
    checked: number;
    expired: number;
    partial: number;
    paid: number;
    waitingOnchain: number;
    errors: number;
  }> {
    const now = this.now();
    const intents = await this.deps.repos.listDueIntents(now, limit);
    let expired = 0;
    let partial = 0;
    let paid = 0;
    let waitingOnchain = 0;
    let errors = 0;

    for (const intent of intents) {
      try {
        if (intent.lightningPaymentHash) {
          const result = await this.applyLightningPayment(
            intent.lightningPaymentHash,
          );
          if (result.status === 'pago') {
            paid++;
            continue;
          }
        }

        const onchainSum = intent.onchainAddressId
          ? await this.deps.repos.sumOnchainForIntent(intent.id, ['confirmado'])
          : 0n;

        // Mempool nao segura o prazo. So o que ja confirmou conta aqui.
        // O watcher segue olhando a cobranca expirada ate grace_until.

        if (onchainSum > 0n) {
          const updated = await this.deps.repos.markIntentPartial(intent.id);
          if (updated) {
            partial++;
            await this.enqueueEvent(
              updated,
              'payment_intent.partial',
              'partial',
            );
          }
        } else {
          const updated = await this.deps.repos.markIntentExpired(intent.id);
          if (updated) {
            expired++;
            await this.enqueueEvent(
              updated,
              'payment_intent.expired',
              'expired',
            );
          }
        }
      } catch (err) {
        errors++;
        this.deps.logger.error(
          { err, intentId: intent.id },
          'erro ao expirar/conciliar intent',
        );
      }
    }

    return {
      checked: intents.length,
      expired,
      partial,
      paid,
      waitingOnchain,
      errors,
    };
  }

  private async handleExisting(
    intent: PaymentIntent,
    amountSats: bigint,
  ): Promise<CreatedPaymentIntent> {
    if (intent.amountSats !== amountSats) {
      throw new ConflictError(
        'external_id ja existe com outro valor; use um external_id novo',
      );
    }
    if (intent.status === 'criando') {
      throw new ConflictError(
        'cobranca ainda esta sendo criada; tente novamente',
      );
    }
    if (intent.status === 'falha_criacao') {
      throw new ConflictError(
        'external_id ja foi usado em uma cobranca que falhou; use outro',
      );
    }
    return { dto: await this.toDto(intent), reused: true };
  }

  private async enqueueEvent(
    intent: PaymentIntent,
    eventType: string,
    dedupeSuffix: string,
  ): Promise<void> {
    await enqueueIntentEvent(
      { repos: this.deps.repos, now: () => this.now() },
      intent,
      eventType as Parameters<typeof enqueueIntentEvent>[2],
      dedupeSuffix,
    );
  }

  async toDto(intent: PaymentIntent): Promise<PaymentIntentDto> {
    const address: HdAddress | null = intent.onchainAddressId
      ? await this.deps.repos.findHdAddressById(intent.onchainAddressId)
      : null;

    let onchain: PaymentIntentOnchainDto | null = null;
    let qrSvg: string | null = null;
    if (address) {
      const bip21 = buildBip21({
        address: address.address,
        amountSats: intent.amountSats,
        label: intent.description ?? intent.externalId,
        ...(intent.lightningInvoice
          ? { lightning: intent.lightningInvoice }
          : {}),
      });
      onchain = {
        address: address.address,
        amount_btc: satsToBtc(intent.amountSats),
        bip21,
      };
      qrSvg = await QRCode.toString(bip21, {
        type: 'svg',
        width: 320,
        margin: 1,
        errorCorrectionLevel: 'M',
      });
    }

    return {
      id: intent.id,
      external_id: intent.externalId,
      status: intent.status,
      amount_sats: intent.amountSats.toString(),
      description: intent.description,
      expires_at: intent.expiresAt.toISOString(),
      grace_until: intent.graceUntil.toISOString(),
      paid_at: intent.paidAt?.toISOString() ?? null,
      paid_rail: intent.paidRail,
      paid_amount_sats: intent.paidAmountSats?.toString() ?? null,
      overpaid_sats: intent.overpaidSats?.toString() ?? null,
      lightning:
        intent.lightningInvoice && intent.lightningPaymentHash
          ? {
              invoice: intent.lightningInvoice,
              payment_hash: intent.lightningPaymentHash,
              expires_at: intent.lightningExpiresAt?.toISOString() ?? null,
            }
          : null,
      onchain,
      payment_uri: onchain?.bip21 ?? null,
      qr_svg: qrSvg,
      created_at: intent.createdAt.toISOString(),
      updated_at: intent.updatedAt.toISOString(),
    };
  }
}
