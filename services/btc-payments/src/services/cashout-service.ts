import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { LuniumError, type LuniumCashOut, type LuniumClient } from '../adapters/lunium/client.js';
import { BrCodeError, maskPixKey, parseBrCode } from '../domain/brcode.js';
import {
  assertCashOutTransition,
  isFinalCashOutStatus,
  mapLuniumCashOutState,
} from '../domain/cashout.js';
import {
  ConflictError,
  NotFoundError,
  QuoteExpiredError,
  ServiceUnavailableError,
  UpstreamError,
  ValidationError,
} from '../domain/errors.js';
import { parseDecimalToMinor, type CashOutCharge } from '../domain/types.js';
import type { Repositories } from '../db/repositories.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';
import type { AppFlags } from './flags-service.js';
import { enqueueCashOutEvent, type CashOutEventType } from './cashout-events.js';

export type CreateCashOutInput = {
  clientId: string;
  externalId: string;
  /**
   * Valor do Pix em centavos.
   *
   * Com `brCode`, o valor vem de dentro do codigo (e o codigo manda); sem
   * ele, e obrigatorio.
   */
  amountBrlCents?: bigint;
  /** Endereco de onde o USDC sai (o `settlement_address` do cliente). */
  originAddress: string;
  pixKey?: string | null;
  pixKeyType?: string | null;
  /** BR Code do Pix: traz valor e recebedor. Exclusivo com pixKey/amount. */
  brCode?: string | null;
  refundAddress?: string | null;
  metadata?: Record<string, unknown> | null;
  sandboxScenario?: string | null;
};

export type CashOutQuoteDto = {
  asset: 'USDC';
  network: 'polygon';
  /** Valor do Pix em reais (string decimal). */
  brl_amount: string;
  /** Quantidade a depositar, em USDC (string decimal). */
  amount: string;
  fee_total_cents: number | null;
  expires_at: string | null;
  merchant_name: string | null;
  pix_key: string | null;
  /**
   * Titular da chave Pix no DICT (via Lunium), quando deu para conferir:
   * nome, banco e documento mascarado. `null` quando a consulta nao esta
   * disponivel ou a chave nao foi verificada (nao bloqueia a venda).
   */
  recipient: { name: string; institution: string | null; document_masked: string | null; source: 'dict' | 'sandbox' } | null;
  /**
   * `true` quando a chave da Lunium e de sandbox.
   *
   * No sandbox o endereco de deposito e um endereco EVM sem dono: o app nao
   * pode assinar. Como a chave fica no motor, quem sabe do sandbox e o motor
   * — o app precisa da resposta para nao assinar.
   */
  sandbox: boolean;
};

export type CashOutDto = {
  id: string;
  external_id: string;
  provider: 'lunium';
  provider_cashout_id: string | null;
  /** Estado canonico do motor. */
  status: CashOutCharge['status'];
  /** Estado cru da Lunium, como veio. */
  provider_state: string | null;
  amount_brl_cents: string;
  asset: 'USDC';
  network: 'polygon';
  /** Endereco de onde o USDC sai. */
  origin_address: string;
  /** Endereco de deposito da Lunium: so existe depois do accept. */
  deposit_address: string | null;
  deposit_tag: string | null;
  /** Quantidade a depositar, em unidades minimas do token. */
  amount_asset_minor: string | null;
  fee_total_cents: number | null;
  pix_key: string | null;
  pix_key_type: string | null;
  merchant_name: string | null;
  path: string | null;
  tx_hash: string | null;
  pix_e2e: string | null;
  pix_paid_at: string | null;
  receipt_url: string | null;
  verify_url: string | null;
  expires_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type CashOutServiceDeps = {
  /**
   * Flags do app gravadas no motor (desligamento remoto). Sem elas, vale so a
   * configuracao do ambiente.
   */
  flags?: { get(): Promise<{ flags: AppFlags }> };
  repos: Repositories;
  lunium: LuniumClient;
  config: AppConfig;
  logger: Logger;
  alerts?: AlertService;
  now?: () => Date;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/**
 * Cash-out: o usuario vende cripto por Pix.
 *
 * O caminho tem tres passos, e o **motor nao assina nada**:
 *
 *  1. `POST /v1/user/cash-out-charges` cria a ordem (a cotacao fica travada);
 *  2. `POST /v1/user/cash-out-charges/accept` (interno) pede o aceite e
 *     recebe o endereco de deposito da Lunium;
 *  3. o app assina a transferencia de USDC e reporta o `tx_hash`
 *     (`POST /v1/user/cash-out-charges/:id/deposit`).
 *
 * A Lunium ve o deposito, vende e paga o Pix. O motor acompanha.
 */
export class CashOutService {
  private readonly deps: CashOutServiceDeps;

  constructor(deps: CashOutServiceDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Previa da cotacao. Nao cria nada e nao persiste (D30).
   *
   * O BR Code e validado aqui (D28): CRC16 conferido, chave presente e
   * valor (quando houver) coerente com o pedido.
   */
  async quote(input: {
    amountBrlCents?: bigint | null;
    pixKey?: string | null;
    pixKeyType?: string | null;
    brCode?: string | null;
    refundAddress?: string | null;
    sandboxScenario?: string | null;
  }): Promise<CashOutQuoteDto> {
    await this.assertEnabled();
    const target = this.resolveTarget(input);
    await this.assertWithinLimits(target.amountBrlCents);
    const preview = await this.deps.lunium.previewCashOut({
      asset: this.deps.config.cashout.asset,
      network: this.deps.config.cashout.network,
      ...target.body,
      ...(input.refundAddress ? { refundAddress: input.refundAddress } : {}),
      ...(this.isSandbox() && input.sandboxScenario
        ? { sandboxScenario: input.sandboxScenario }
        : {}),
    });
    return {
      asset: 'USDC',
      network: 'polygon',
      brl_amount:
        preview.brl_amount ??
        (target.amountBrlCents ? centsToDecimal(target.amountBrlCents) : '0'),
      amount: preview.amount ?? '0',
      fee_total_cents: preview.fee_total_cents ?? null,
      expires_at: preview.expires_at ?? null,
      merchant_name: preview.merchant_name ?? null,
      pix_key: preview.pix_key ? maskPixKey(preview.pix_key) : null,
      recipient: await this.lookupRecipient(input),
      sandbox: this.isSandbox(),
    };
  }

  /**
   * Quem recebe o Pix, pelo DICT. Vale para chave digitada e para QR estatico
   * (a chave esta dentro do codigo); QR dinamico nao traz a chave. Nunca
   * derruba a cotacao: sem resposta conferida, `null`.
   */
  private async lookupRecipient(input: { pixKey?: string | null; pixKeyType?: string | null; brCode?: string | null }): Promise<CashOutQuoteDto['recipient']> {
    let key = input.pixKey ?? null;
    let type = input.pixKeyType ?? null;
    if (!key && input.brCode) {
      try {
        key = parseBrCode(input.brCode).key;
        type = null;
      } catch {
        key = null;
      }
    }
    if (!key) return null;
    try {
      const found = await this.deps.lunium.lookupPixKey(key, type);
      if (found.available === false || !found.verified || !found.owner_name || found.source === 'disabled') return null;
      return {
        name: found.owner_name,
        institution: found.institution_name ?? null,
        document_masked: found.owner_tax_number ?? null,
        source: found.source,
      };
    } catch (err) {
      this.deps.logger.debug({ err }, 'consulta do titular Pix indisponivel');
      return null;
    }
  }

  /**
   * Cria a ordem. Idempotente por `(client_id, external_id)`: repetir com o
   * mesmo id e o mesmo valor devolve a ordem existente; com valor diferente,
   * 409.
   */
  async create(
    input: CreateCashOutInput,
  ): Promise<{ dto: CashOutDto; reused: boolean }> {
    await this.assertEnabled();
    const target = this.resolveTarget({
      amountBrlCents: input.amountBrlCents,
      pixKey: input.pixKey,
      pixKeyType: input.pixKeyType,
      brCode: input.brCode,
    });
    // O limite vale sobre o valor efetivo: com BR Code, o valor vem de dentro
    // do codigo (antes o limite olhava so o corpo e um QR de qualquer valor
    // passava).
    await this.assertWithinLimits(target.amountBrlCents);

    const existing = await this.deps.repos.findCashOutChargeByClientAndExternalId(
      input.clientId,
      input.externalId,
    );
    if (existing) {
      if (existing.amountBrlCents !== target.amountBrlCents) {
        throw new ConflictError('external_id ja usado com dados diferentes');
      }
      return { dto: await this.toDto(existing), reused: true };
    }

    const id = randomUUID();
    const providerExternalId = `cashout_${id}`;
    // A linha nasce **antes** da chamada: um timeout deixa rastro e o retry
    // com o mesmo external_id devolve a mesma ordem.
    const created = await this.deps.repos.createCashOutCharge({
      id,
      clientId: input.clientId,
      externalId: input.externalId,
      providerExternalId,
      amountBrlCents: target.amountBrlCents,
      originAddress: input.originAddress.toLowerCase(),
      pixKeyMasked: target.body.pixKey ? maskPixKey(target.body.pixKey) : null,
      pixKeyType: target.body.pixKeyType ?? null,
      brCode: target.body.brCode ?? null,
      metadata: input.metadata ?? null,
    });

    try {
      const order = await this.deps.lunium.createCashOut({
        asset: this.deps.config.cashout.asset,
        network: this.deps.config.cashout.network,
        ...target.body,
        externalId: providerExternalId,
        ...(input.refundAddress ? { refundAddress: input.refundAddress } : {}),
        ...(this.isSandbox() && input.sandboxScenario
          ? { sandboxScenario: input.sandboxScenario }
          : {}),
      });
      const updated = await this.applyProviderOrder(created, order);
      await enqueueCashOutEvent(
        { repos: this.deps.repos, now: () => this.now() },
        updated,
        'cashout.created',
        'created',
      );
      return { dto: await this.toDto(updated), reused: false };
    } catch (err) {
      await this.deps.repos.updateCashOutCharge({
        id: created.id,
        error: errorMessage(err),
        attempts: created.attempts + 1,
      });
      if (err instanceof LuniumError && err.statusCode >= 500) {
        throw new UpstreamError('a LuniumPay nao respondeu a criacao do cash-out');
      }
      throw err;
    }
  }

  /**
   * Aceita a cotacao: a Lunium devolve o endereco de deposito.
   *
   * O motor nao envia nada — o app e que assina a transferencia.
   */
  async accept(
    id: string,
    clientId: string,
  ): Promise<CashOutDto> {
    await this.assertEnabled();
    const local = await this.requireForClient(id, clientId);
    if (!local.providerCashoutId) {
      throw new ServiceUnavailableError('a ordem ainda nao tem id na LuniumPay');
    }
    try {
      const accepted = await this.deps.lunium.acceptCashOut(local.providerCashoutId);
      const updated = await this.applyProviderOrder(local, accepted);
      return this.toDto(updated);
    } catch (err) {
      if (err instanceof LuniumError && err.code === 'cotacao_expirada') {
        await this.deps.repos.updateCashOutCharge({
          id: local.id,
          status: 'expirado',
          error: 'cotacao expirada na LuniumPay; faca uma nova cotacao',
        });
        throw new QuoteExpiredError();
      }
      throw err;
    }
  }

  /** Registra o `tx_hash` que o app assinou (rastreabilidade). */
  async reportDeposit(
    id: string,
    clientId: string,
    txHash: string,
  ): Promise<CashOutDto> {
    // Valida antes de tocar no banco: um tx_hash malformado nao e consulta.
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new ValidationError('tx_hash invalido');
    }
    const local = await this.requireForClient(id, clientId);
    const updated = await this.deps.repos.updateCashOutCharge({
      id: local.id,
      txHash,
      error: null,
    });
    return this.toDto(updated ?? local);
  }

  /** Estado atual da ordem (consulta a Lunium). */
  async sync(id: string, clientId: string): Promise<CashOutDto> {
    const local = await this.requireForClient(id, clientId);
    if (!local.providerCashoutId) return this.toDto(local);
    try {
      const order = await this.deps.lunium.getCashOut(local.providerCashoutId);
      const updated = await this.applyProviderOrder(local, order);
      return this.toDto(updated);
    } catch (err) {
      this.deps.logger.warn(
        { err, cashOutId: id },
        'nao foi possivel consultar o cash-out na LuniumPay',
      );
      return this.toDto(local);
    }
  }

  /** Carteira de devolucao, quando a venda falhar. */
  async setRefundAddress(
    id: string,
    clientId: string,
    refundAddress: string,
  ): Promise<CashOutDto> {
    const local = await this.requireForClient(id, clientId);
    if (!/^0x[a-fA-F0-9]{40}$/.test(refundAddress)) {
      throw new ValidationError('endereco de devolucao invalido');
    }
    if (!local.providerCashoutId) {
      throw new ServiceUnavailableError('a ordem ainda nao tem id na LuniumPay');
    }
    const order = await this.deps.lunium.setCashOutRefundAddress(
      local.providerCashoutId,
      refundAddress,
    );
    const updated = await this.applyProviderOrder(local, order);
    return this.toDto(updated);
  }

  /**
   * Conciliacao:_orders_ nao terminais sao consultadas na LuniumPay.
   *
   * O app acompanha por polling; este job e a rede de seguranca para quando o
   * app fica fechado e o estado muda.
   */
  async reconcile(limit: number): Promise<{
    checked: number;
    synced: number;
    errors: number;
    skipped?: boolean;
  }> {
    const cooldown = this.deps.lunium.rateLimiter?.cooldownRemaining() ?? 0;
    if (cooldown > 0) {
      this.deps.logger.warn(
        { cooldownMs: cooldown },
        'reconciliacao de cash-out adiada: limite da Lunium em cooldown',
      );
      return { checked: 0, synced: 0, errors: 0, skipped: true };
    }
    const charges = await this.deps.repos.listCashOutChargesToReconcile(limit);
    let synced = 0;
    let errors = 0;
    for (const charge of charges) {
      try {
        if (!charge.providerCashoutId) continue;
        const order = await this.deps.lunium.getCashOut(charge.providerCashoutId);
        await this.applyProviderOrder(charge, order);
        synced++;
      } catch (err) {
        errors++;
        this.deps.logger.error(
          { err, cashOutId: charge.id },
          'erro ao reconciliar cash-out',
        );
      }
    }
    return { checked: charges.length, synced, errors };
  }

  /**
   * Aplica o estado do provedor no canônico.
   *
   * Um estado final nao volta: se a Lunium mandar `EXPIRED` depois de
   * `COMPLETED`, a ordem vai para `manual` (e nao para `expirado`), porque
   * foi paga.
   */
  async applyProviderOrder(
    local: CashOutCharge,
    order: LuniumCashOut,
  ): Promise<CashOutCharge> {
    const providerState = (order.state ?? null) as CashOutCharge['providerState'];
    const mapped = mapLuniumCashOutState(providerState);

    // Estado final nao regride: o que foi pago nao volta.
    const status =
      isFinalCashOutStatus(local.status) && local.status !== mapped
        ? 'manual'
        : mapped;

    if (status !== local.status) {
      assertCashOutTransition(local.status, status);
    }

    const amountMinor =
      order.amount != null
        ? parseDecimalToMinor(order.amount, 6)
        : local.amountAssetMinor;

    const updated = await this.deps.repos.updateCashOutCharge({
      id: local.id,
      status,
      providerState,
      providerCashoutId: order.cashout_id ?? local.providerCashoutId,
      depositAddress: order.deposit_address ?? local.depositAddress,
      depositTag: order.deposit_tag ?? local.depositTag,
      amountAssetMinor: amountMinor,
      feeTotalCents:
        order.fee_total_cents != null
          ? BigInt(order.fee_total_cents)
          : local.feeTotalCents,
      providerPath: order.path ?? local.providerPath,
      pixE2e: order.pix_e2e ?? local.pixE2e,
      pixPaidAt: order.pix_paid_at ? new Date(order.pix_paid_at) : local.pixPaidAt,
      receiptUrl: order.receipt_url ?? local.receiptUrl,
      verifyUrl: order.verify_url ?? local.verifyUrl,
      refundAddress: order.refund_address ?? local.refundAddress,
      providerPayload: order as unknown as Record<string, unknown>,
      error: order.failure_reason ?? null,
      lastCheckedAt: this.now(),
      version: local.version + 1,
    });

    const result = updated ?? local;
    if (status !== local.status) {
      const eventType = cashOutEventFor(status);
      if (eventType) {
        await enqueueCashOutEvent(
          { repos: this.deps.repos, now: () => this.now() },
          result,
          eventType,
          status,
        );
      }
    }
    if (status !== local.status && (status === 'falhou' || status === 'manual')) {
      await this.deps.alerts?.send({
        level: 'error',
        title: `cash-out em ${status}`,
        metadata: { cashOutId: local.id, externalId: local.externalId },
      });
    }
    return result;
  }

  private async requireForClient(
    id: string,
    clientId: string,
  ): Promise<CashOutCharge> {
    const local = await this.deps.repos.findCashOutChargeByIdForClient(id, clientId);
    if (!local) throw new NotFoundError('cash-out nao encontrado');
    return local;
  }

  /**
   * Ambiente ligado **e** flag do operador ligada. A flag e o desligamento
   * remoto: vale para qualquer versao do app, porque e o motor que recusa.
   * O registro de deposito nao passa por aqui (quem ja enviou o USDC precisa
   * ser acompanhado).
   */
  private async assertEnabled(): Promise<void> {
    if (!this.deps.config.cashout.enabled) {
      throw new ServiceUnavailableError('cash-out desabilitado');
    }
    if (this.deps.flags && !(await this.deps.flags.get()).flags.cash_out_enabled) {
      throw new ServiceUnavailableError('cash-out desligado pelo operador');
    }
  }

  /** Limites do ambiente e das flags: vale o mais restrito. */
  private async assertWithinLimits(amount: bigint): Promise<void> {
    let min = this.deps.config.cashout.minBrlCents;
    let max = this.deps.config.cashout.maxBrlCents;
    if (this.deps.flags) {
      const { flags } = await this.deps.flags.get();
      const flagMin = BigInt(Math.round(flags.min_cash_out_brl * 100));
      const flagMax = BigInt(Math.round(flags.max_cash_out_brl * 100));
      if (flagMin > min) min = flagMin;
      if (flagMax < max) max = flagMax;
    }
    if (amount < min) {
      throw new ValidationError(`valor abaixo do minimo (${min.toString()} centavos)`);
    }
    if (amount > max) {
      throw new ValidationError(`valor acima do maximo (${max.toString()} centavos)`);
    }
  }

  private isSandbox(): boolean {
    return this.deps.config.pix.luniumApiKey?.startsWith('lun_test_') ?? false;
  }

  /**
   * Define o alvo da venda: BR Code **ou** chave+valor, nunca os dois.
   *
   * Com BR Code, o valor e o recebedor vem de dentro do codigo — e o motor
   * confere o CRC16 (D28).
   */
  private resolveTarget(input: {
    amountBrlCents?: bigint | null | undefined;
    pixKey?: string | null | undefined;
    pixKeyType?: string | null | undefined;
    brCode?: string | null | undefined;
  }): {
    /** Valor efetivo do Pix, em centavos. */
    amountBrlCents: bigint;
    /** Corpo para a Lunium: BR Code **ou** chave+valor, nunca os dois. */
    body: {
      amount?: string;
      brlAmount?: string;
      pixKey?: string;
      pixKeyType?: string;
      brCode?: string;
    };
  } {
    const hasBrCode = Boolean(input.brCode);
    const hasKey = Boolean(input.pixKey);

    if (hasBrCode) {
      let parsed;
      try {
        parsed = parseBrCode(input.brCode as string);
      } catch (err) {
        if (err instanceof BrCodeError) {
          throw new ValidationError(err.message);
        }
        throw err;
      }
      const codeAmount = parsed.amount ? decimalToCents(parsed.amount) : null;
      if (
        input.amountBrlCents != null &&
        codeAmount != null &&
        input.amountBrlCents !== codeAmount
      ) {
        throw new ValidationError(
          'valor do pedido difere do valor do BR Code',
        );
      }
      // QR sem valor nao vai como BR Code: a Lunium so paga cobranca com
      // valor (medido em producao). O estatico vira chave + valor no app; o
      // dinamico sem valor no codigo nao tem como ser pago aqui.
      if (codeAmount == null) {
        throw new ValidationError(
          parsed.dynamic
            ? 'QR dinamico sem valor no codigo: nao da para pagar por aqui'
            : 'BR Code sem valor: peça um QR com valor ou envie a chave Pix e o valor',
        );
      }
      const amount = codeAmount;
      // A Lunium le o valor e o recebedor de dentro do codigo: so ele vai.
      return { amountBrlCents: amount, body: { brCode: input.brCode as string } };
    }

    if (!hasKey) {
      throw new ValidationError('informe o BR Code do Pix ou a chave Pix');
    }
    if (input.amountBrlCents == null) {
      throw new ValidationError('informe o valor do Pix');
    }
    return {
      amountBrlCents: input.amountBrlCents,
      body: {
        brlAmount: centsToDecimal(input.amountBrlCents),
        pixKey: input.pixKey as string,
        ...(input.pixKeyType ? { pixKeyType: input.pixKeyType } : {}),
      },
    };
  }

  async toDto(charge: CashOutCharge): Promise<CashOutDto> {
    const payload = charge.providerPayload as
      | (Record<string, unknown> | null)
      | undefined;
    return {
      id: charge.id,
      external_id: charge.externalId,
      provider: charge.provider,
      provider_cashout_id: charge.providerCashoutId,
      status: charge.status,
      provider_state: charge.providerState,
      amount_brl_cents: charge.amountBrlCents.toString(),
      asset: charge.asset,
      network: charge.network,
      origin_address: charge.originAddress,
      deposit_address: charge.depositAddress,
      deposit_tag: charge.depositTag,
      amount_asset_minor: charge.amountAssetMinor?.toString() ?? null,
      fee_total_cents: charge.feeTotalCents == null ? null : Number(charge.feeTotalCents),
      pix_key: charge.pixKeyMasked,
      pix_key_type: charge.pixKeyType,
      merchant_name:
        typeof payload?.merchant_name === 'string' ? payload.merchant_name : null,
      path: charge.providerPath,
      tx_hash: charge.txHash,
      pix_e2e: charge.pixE2e,
      pix_paid_at: iso(charge.pixPaidAt),
      receipt_url: charge.receiptUrl,
      verify_url: charge.verifyUrl,
      expires_at: iso(charge.expiresAt),
      error: charge.error,
      created_at: charge.createdAt.toISOString(),
      updated_at: charge.updatedAt.toISOString(),
    };
  }
}

/** Estado canonico -> evento de saida. */
function cashOutEventFor(status: CashOutCharge['status']): CashOutEventType | null {
  switch (status) {
    case 'aguardando_deposito':
      return 'cashout.awaiting_deposit';
    case 'depositado':
      return 'cashout.deposit_detected';
    case 'pago':
      return 'cashout.paid';
    case 'liquidado':
      return 'cashout.settled';
    case 'expirado':
      return 'cashout.expired';
    case 'reembolsado':
      return 'cashout.refunded';
    case 'falhou':
      return 'cashout.failed';
    case 'manual':
      return 'cashout.manual';
    default:
      return null;
  }
}

/** Decimal com duas casas -> centavos ("6.50" -> 650). */
export function decimalToCents(value: string): bigint {
  const clean = value.trim();
  const [whole = '0', fraction = ''] = clean.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
}

/** Centavos -> decimal com duas casas ("650" -> "6.50"). */
export function centsToDecimal(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
