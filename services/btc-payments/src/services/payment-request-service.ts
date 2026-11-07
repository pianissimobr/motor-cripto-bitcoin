import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import { buildBrCode, maskPixKey } from '../domain/brcode.js';
import {
  ConflictError,
  ServiceUnavailableError,
  ValidationError,
} from '../domain/errors.js';
import type { PaymentRequest } from '../db/repositories.js';
import type { Logger } from '../logger.js';
import type { PixChargeService } from './pix-charge-service.js';
import type { SwapService } from './swap-service.js';

export type PaymentRequestRail = 'pix' | 'bitcoin' | 'pix_direto';

export const PAYMENT_REQUEST_RAILS: readonly PaymentRequestRail[] = [
  'pix',
  'bitcoin',
  'pix_direto',
];

export type PaymentRequestServiceDeps = {
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  pixCharges?: PixChargeService;
  swap?: SwapService;
  now?: () => Date;
};

export type CreatePaymentRequestInput = {
  clientId: string;
  externalId: string;
  amountFiatCents: bigint;
  currency: 'BRL' | 'USD';
  rails?: PaymentRequestRail[];
  payerTaxNumber?: string | null;
  payerName?: string | null;
  description?: string | null;
  expiresInSeconds?: number;
  metadata?: Record<string, unknown> | null;
};

export type PaymentRequestDto = {
  id: string;
  external_id: string;
  amount_cents: string;
  currency: 'BRL' | 'USD';
  status: PaymentRequest['status'];
  expires_at: string | null;
  options: {
    pix: {
      charge_id: string;
      qr_copypaste: string | null;
      qr_image_url: string | null;
      qr_svg: string | null;
      expires_at: string | null;
    } | null;
    bitcoin: {
      swap_id: string;
      address: string | null;
      amount_btc: string;
      bip21: string | null;
      qr_svg: string | null;
      expires_at: string | null;
    } | null;
    pix_direto: {
      br_code: string;
      key_masked: string;
      key_type: string | null;
      amount: string;
      txid: string;
    } | null;
  };
  created_at: string;
  updated_at: string;
};

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/**
 * Pedido de pagamento com mais de um trilho.
 *
 * O site manda o valor (e o CPF do pagador, quando o trilho e Pix) e o motor
 * devolve as opcoes prontas: o Pix da LuniumPay, o Bitcoin que vira dolar
 * digital e o Pix direto na chave do proprio usuario. O pagador escolhe o QR;
 * o motor acompanha os tres e sabe qual deles foi pago.
 *
 * O `external_id` do site e a chave de idempotencia: repetir a chamada com o
 * mesmo id devolve o mesmo pedido, sem abrir cobrancas novas.
 */
export class PaymentRequestService {
  constructor(private readonly deps: PaymentRequestServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async create(
    input: CreatePaymentRequestInput,
  ): Promise<{ dto: PaymentRequestDto; reused: boolean }> {
    if (input.amountFiatCents <= 0n) {
      throw new ValidationError('valor invalido');
    }

    const existing = await this.deps.repos.findPaymentRequestByClientAndExternalId(
      input.clientId,
      input.externalId,
    );
    if (existing) {
      return { dto: await this.toDto(existing), reused: true };
    }

    const pixKey = await this.deps.repos.findClientPixKeyByClientId(input.clientId);
    const rails = this.resolveRails(input.rails, pixKey !== null);
    if (rails.length === 0) {
      throw new ValidationError('nenhum trilho disponivel para este pedido');
    }
    if (rails.includes('pix') && !input.payerTaxNumber) {
      throw new ValidationError(
        'o trilho Pix exige o CPF/CNPJ do pagador (payer_tax_number)',
      );
    }

    const expiresAt = input.expiresInSeconds
      ? new Date(this.now().getTime() + input.expiresInSeconds * 1000)
      : null;
    const created = await this.deps.repos.createPaymentRequest({
      id: randomUUID(),
      clientId: input.clientId,
      externalId: input.externalId,
      amountFiatCents: input.amountFiatCents,
      currency: input.currency,
      rails,
      expiresAt,
      metadata: input.metadata ?? null,
    });

    try {
      const updated = await this.createOptions(created, input, pixKey);
      return { dto: await this.toDto(updated), reused: false };
    } catch (err) {
      // O pedido fica registrado: a retentativa com o mesmo `external_id` nao
      // abre uma segunda cobranca.
      await this.deps.repos.updatePaymentRequest({
        id: created.id,
        status: 'falha',
      });
      throw err;
    }
  }

  /**
   * Trilhos pedidos.
   *
   * O padrao e Pix + Bitcoin. O "Pix direto" entra quando o usuario tem uma
   * chave Pix configurada.
   */
  private resolveRails(
    requested: PaymentRequestRail[] | undefined,
    hasPixKey: boolean,
  ): PaymentRequestRail[] {
    if (requested && requested.length > 0) {
      for (const rail of requested) {
        if (!PAYMENT_REQUEST_RAILS.includes(rail)) {
          throw new ValidationError(`trilho desconhecido: ${rail}`);
        }
      }
      return requested.filter((rail) => rail !== 'pix_direto' || hasPixKey);
    }
    const rails: PaymentRequestRail[] = ['pix', 'bitcoin'];
    if (hasPixKey) rails.push('pix_direto');
    return rails;
  }

  /** Cria o que cada trilho precisa e guarda a ligacao no pedido. */
  private async createOptions(
    request: PaymentRequest,
    input: CreatePaymentRequestInput,
    pixKey: { pixKey: string; pixKeyType: string | null; merchantName: string | null; city: string | null } | null,
  ): Promise<PaymentRequest> {
    let pixChargeId: string | null = null;
    let swapOrderId: string | null = null;
    let pixDirect: PaymentRequest['pixDirect'] = null;

    if (request.rails.includes('pix')) {
      if (!this.deps.pixCharges) {
        throw new ServiceUnavailableError('PIX indisponivel');
      }
      const charge = await this.deps.pixCharges.create({
        clientId: input.clientId,
        externalId: `${input.externalId}:pix`,
        amountBrlCents: input.amountFiatCents,
        payerTaxNumber: input.payerTaxNumber!,
        ...(input.payerName ? { payerName: input.payerName } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      pixChargeId = charge.dto.id;
    }

    if (request.rails.includes('bitcoin')) {
      if (!this.deps.swap) {
        throw new ServiceUnavailableError('swap indisponivel');
      }
      const swap = await this.deps.swap.create({
        clientId: input.clientId,
        externalId: `${input.externalId}:btc`,
        amountFiatCents: input.amountFiatCents,
        currency: input.currency,
        ...(input.description ? { description: input.description } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      swapOrderId = swap.dto.id;
    }

    if (request.rails.includes('pix_direto') && pixKey) {
      const txid = `PR${request.id.replace(/-/g, '').slice(0, 18).toUpperCase()}`;
      const reais = (input.amountFiatCents / 100n).toString();
      const cents = (input.amountFiatCents % 100n).toString().padStart(2, '0');
      const amount = `${reais}.${cents}`;
      const brCode = buildBrCode({
        key: pixKey.pixKey,
        ...(pixKey.merchantName ? { merchantName: pixKey.merchantName } : {}),
        ...(pixKey.city ? { city: pixKey.city } : {}),
        amount,
        txid,
      });
      pixDirect = {
        br_code: brCode,
        key_masked: maskPixKey(pixKey.pixKey),
        key_type: pixKey.pixKeyType,
        txid,
        amount,
      };
    }

    const updated = await this.deps.repos.updatePaymentRequest({
      id: request.id,
      status: 'pendente',
      pixChargeId,
      swapOrderId,
      pixDirect,
    });
    return updated ?? request;
  }

  /** Estado do pedido, com o estado de cada trilho. */
  async get(id: string, clientId?: string): Promise<PaymentRequestDto | null> {
    const request = clientId
      ? await this.deps.repos.findPaymentRequestByIdForClient(id, clientId)
      : await this.deps.repos.findPaymentRequestById(id);
    if (!request) return null;
    return this.toDto(request);
  }

  private async toDto(request: PaymentRequest): Promise<PaymentRequestDto> {
    let pix: PaymentRequestDto['options']['pix'] = null;
    if (request.pixChargeId && this.deps.pixCharges) {
      const charge = await this.deps.pixCharges.getById(
        request.clientId,
        request.pixChargeId,
      );
      pix = {
        charge_id: charge.id,
        qr_copypaste: charge.pix?.qr_copypaste ?? null,
        qr_image_url: charge.pix?.qr_image_url ?? null,
        qr_svg: charge.pix?.qr_svg ?? null,
        expires_at: charge.pix?.expires_at ?? null,
      };
    }

    let bitcoin: PaymentRequestDto['options']['bitcoin'] = null;
    if (request.swapOrderId && this.deps.swap) {
      const swap = await this.deps.swap.get(request.swapOrderId, request.clientId);
      if (swap) {
        bitcoin = {
          swap_id: swap.id,
          address: swap.bitcoin.address,
          amount_btc: swap.bitcoin.amount_btc,
          bip21: swap.bitcoin.bip21,
          qr_svg: swap.bitcoin.qr_svg,
          expires_at: swap.bitcoin.expires_at,
        };
      }
    }

    let pixDirect: PaymentRequestDto['options']['pix_direto'] = null;
    if (request.pixDirect) {
      pixDirect = {
        br_code: request.pixDirect.br_code,
        key_masked: request.pixDirect.key_masked,
        key_type: request.pixDirect.key_type,
        amount: request.pixDirect.amount,
        txid: request.pixDirect.txid,
      };
    }

    return {
      id: request.id,
      external_id: request.externalId,
      amount_cents: request.amountFiatCents.toString(),
      currency: request.currency,
      status: request.status,
      expires_at: iso(request.expiresAt),
      options: { pix, bitcoin, pix_direto: pixDirect },
      created_at: request.createdAt.toISOString(),
      updated_at: request.updatedAt.toISOString(),
    };
  }
}
