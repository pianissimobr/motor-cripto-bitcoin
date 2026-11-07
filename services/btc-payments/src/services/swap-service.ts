import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import { buildBip21 } from '../domain/bip21.js';
import {
  ConflictError,
  ServiceUnavailableError,
  ValidationError,
} from '../domain/errors.js';
import { fiatCentsToSats } from '../domain/fx.js';
import { satsToBtc } from '../domain/money.js';
import {
  assertSwapTransition,
  isFinalSwapStatus,
  mapSwapKitStatus,
} from '../domain/swap.js';
import type { SwapOrder, SwapProviderState, SwapStatus } from '../domain/types.js';
import {
  formatBtcAmount,
  usdcToMinor,
  type SwapKitClient,
  type SwapKitQuote,
  type SwapKitQuoteRoute,
  type SwapKitSwap,
} from '../adapters/swapkit/client.js';
import {
  verifySwapDelivery,
  type SwapDeliveryVerification,
} from '../adapters/chain/swap-delivery-verify.js';
import type { AlertService } from './alert-service.js';
import type { FxService } from './fx-service.js';
import type { Logger } from '../logger.js';
import { resolveSettlementDestination } from './settlement-destination.js';

export type SwapServiceDeps = {
  repos: Repositories;
  swapkit: SwapKitClient;
  config: AppConfig;
  logger: Logger;
  alerts?: AlertService;
  fx?: FxService;
  now?: () => Date;
  /**
   * Prova da entrega. Injetavel para os testes nao dependerem da chain.
   */
  verifyDelivery?: (
    order: SwapOrder,
    track: { hash?: string | null },
  ) => Promise<SwapDeliveryVerification>;
};

export type CreateSwapOrderInput = {
  clientId: string;
  externalId: string;
  amountFiatCents: bigint;
  currency: 'BRL' | 'USD';
  destinationAddress?: string | null;
  description?: string | null;
  expiresInSeconds?: number;
  metadata?: Record<string, unknown> | null;
};

export type SwapOrderDto = {
  id: string;
  external_id: string;
  provider: 'swapkit';
  status: SwapStatus;
  provider_state: SwapProviderState | null;
  amount_fiat_cents: string;
  currency: 'BRL' | 'USD';
  amount_sats: string;
  asset: 'USDC';
  network: 'polygon';
  destination_address: string;
  bitcoin: {
    address: string | null;
    amount_btc: string;
    bip21: string | null;
    qr_svg: string | null;
    expires_at: string | null;
  };
  error: string | null;
  created_at: string;
  updated_at: string;
};

type SwapOrderUpdate = Parameters<Repositories['updateSwapOrder']>[0];

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/**
 * Orquestra o trilho "cliente paga Bitcoin -> dolar digital na carteira".
 *
 * O motor nao assina e nao move dinheiro: ele cota o par, pede a SwapKit um
 * endereco de deposito unico, devolve o QR e acompanha o rastreio ate o USDC
 * chegar na carteira do cliente — o que so ele marca como `liquidado`, depois
 * de ler a entrega on-chain.
 *
 * O pagador nunca ve a SwapKit: ele ve um BIP21 comum.
 */
export class SwapService {
  constructor(private readonly deps: SwapServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async toDto(order: SwapOrder): Promise<SwapOrderDto> {
    const amountBtc = formatBtcAmount(order.amountSats);
    let bip21: string | null = null;
    let qrSvg: string | null = null;
    if (order.depositAddress) {
      bip21 = buildBip21({
        address: order.depositAddress,
        amountSats: order.amountSats,
        label: order.externalId,
      });
      try {
        qrSvg = await QRCode.toString(bip21, {
          type: 'svg',
          margin: 1,
          width: 256,
        });
      } catch (err) {
        this.deps.logger.warn(
          { err, swapOrderId: order.id },
          'falha ao gerar QR do swap',
        );
      }
    }
    return {
      id: order.id,
      external_id: order.externalId,
      provider: order.provider,
      status: order.status,
      provider_state: order.providerState,
      amount_fiat_cents: order.amountFiatCents.toString(),
      currency: order.currency,
      amount_sats: order.amountSats.toString(),
      asset: 'USDC',
      network: order.network,
      destination_address: order.destinationAddress,
      bitcoin: {
        address: order.depositAddress,
        amount_btc: amountBtc,
        bip21,
        qr_svg: qrSvg,
        expires_at: iso(order.expiresAt),
      },
      error: order.error,
      created_at: order.createdAt.toISOString(),
      updated_at: order.updatedAt.toISOString(),
    };
  }

  async create(
    input: CreateSwapOrderInput,
  ): Promise<{ dto: SwapOrderDto; reused: boolean }> {
    if (!this.deps.config.swapkit.enabled) {
      throw new ServiceUnavailableError('swap desabilitado');
    }
    if (input.amountFiatCents <= 0n) {
      throw new ValidationError('valor invalido');
    }
    if (input.amountFiatCents < this.deps.config.swapkit.minBrlCents) {
      throw new ValidationError(
        `valor abaixo do minimo (${this.deps.config.swapkit.minBrlCents.toString()} centavos)`,
      );
    }
    if (input.amountFiatCents > this.deps.config.swapkit.maxBrlCents) {
      throw new ValidationError(
        `valor acima do maximo (${this.deps.config.swapkit.maxBrlCents.toString()} centavos)`,
      );
    }

    const existing = await this.deps.repos.findSwapOrderByClientAndExternalId(
      input.clientId,
      input.externalId,
    );
    if (existing) {
      // Com endereco de deposito, o pedido ja esta pronto: a resposta e a
      // mesma, e o pagador pode continuar pagando.
      if (existing.depositAddress) {
        return { dto: await this.toDto(existing), reused: true };
      }
      if (existing.status === 'falhou' || existing.status === 'expirado') {
        // Um pedido que falhou antes de ter endereco pode tentar de novo.
        return this.createOrder(existing, input);
      }
      return { dto: await this.toDto(existing), reused: true };
    }

    const destination = await resolveSettlementDestination({
      repos: this.deps.repos,
      config: this.deps.config,
      clientId: input.clientId,
      explicit: input.destinationAddress ?? null,
    });
    if (!destination) {
      throw new ValidationError(
        'cadastre uma carteira de liquidacao USDC antes de pedir um swap',
      );
    }

    const amountSats = await this.resolveAmountSats(input);
    const id = randomUUID();
    // A linha nasce antes de qualquer chamada de rede: se a cotacao ou a
    // criacao do deposito falhar, o `external_id` ja esta gravado e a
    // retentativa nao abre um segundo pedido.
    const created = await this.deps.repos.createSwapOrder({
      id,
      clientId: input.clientId,
      externalId: input.externalId,
      amountFiatCents: input.amountFiatCents,
      currency: input.currency,
      amountSats,
      sellAsset: this.deps.config.swapkit.sellAsset,
      buyAsset: this.deps.config.swapkit.buyAsset,
      network: 'polygon',
      destinationAddress: destination,
      metadata: input.metadata ?? null,
    });

    return this.createOrder(created, input);
  }

  /**
   * Cota o par e pede o endereco de deposito a SwapKit.
   *
   * O `external_id` ja esta persistido quando esta funcao comeca: o retry usa
   * a mesma linha e o mesmo pedido.
   */
  private async createOrder(
    order: SwapOrder,
    input: CreateSwapOrderInput,
  ): Promise<{ dto: SwapOrderDto; reused: boolean }> {
    try {
      const quote = await this.deps.swapkit.quote({
        sellAsset: this.deps.config.swapkit.sellAsset,
        buyAsset: this.deps.config.swapkit.buyAsset,
        sellAmount: formatBtcAmount(
          order.amountSats,
          this.deps.config.swapkit.amountUnit,
        ),
        destinationAddress: order.destinationAddress,
        providers: this.deps.config.swapkit.providers,
        slippageBps: this.deps.config.swapkit.slippageBps,
      });
      const route = this.pickRoute(quote);
      const swap = await this.deps.swapkit.swap({
        routeId: route.routeId,
        destinationAddress: order.destinationAddress,
      });

      const depositAddress = swap.meta?.depositAddress ?? null;
      if (!depositAddress) {
        throw new ValidationError(
          'a SwapKit nao devolveu endereco de deposito para este pedido',
        );
      }
      const expiration = swap.meta?.depositChannelExpiration ?? null;
      const expiresAt = expiration
        ? new Date(expiration * 1000)
        : new Date(this.now().getTime() + 30 * 60 * 1000);
      const expectedAssetMinor =
        usdcToMinor(route.buyAmount) ?? usdcToMinor(swap.buyAmount ?? null);

      const updated = await this.deps.repos.updateSwapOrder({
        id: order.id,
        status: 'aguardando_deposito',
        providerOrderId: swap.swapId ?? route.routeId,
        depositAddress,
        depositChannelId: swap.meta?.providerDepositChannelId ?? null,
        expectedAssetMinor,
        feeTotalBps: this.totalFeeBps(route),
        expiresAt,
        providerPayload: {
          route: { routeId: route.routeId, providers: route.providers ?? null },
          quoteId: quote.quoteId ?? null,
          swapId: swap.swapId ?? null,
          txType: swap.txType ?? null,
          txHint: swap.txHint ?? null,
          inboundAddress: swap.inboundAddress ?? null,
          buyAmount: route.buyAmount ?? null,
          estimatedTime: route.estimatedTime ?? null,
        },
        error: null,
      } as SwapOrderUpdate);

      const finalOrder = updated ?? order;
      return { dto: await this.toDto(finalOrder), reused: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.repos.updateSwapOrder({
        id: order.id,
        status: 'falhou',
        error: message,
      } as SwapOrderUpdate);
      this.deps.logger.error(
        { err, swapOrderId: order.id, externalId: input.externalId },
        'falha ao criar pedido de swap',
      );
      await this.deps.alerts?.send({
        level: 'error',
        title: 'pedido de swap falhou',
        message,
        metadata: { swapOrderId: order.id, externalId: input.externalId },
      });
      throw err;
    }
  }

  /** A rota preferida e a do primeiro provedor da lista configurada. */
  private pickRoute(quote: SwapKitQuote): SwapKitQuoteRoute {
    const routes = (quote.routes ?? []).filter((route) =>
      Boolean(route.routeId),
    );
    if (routes.length === 0) {
      const providerErrors = (quote.providerErrors ?? [])
        .map((error) => `${error.provider ?? '?'}: ${error.message ?? error.errorCode ?? 'erro'}`)
        .join('; ');
      throw new ValidationError(
        providerErrors
          ? `a SwapKit nao achou rota para o par (${providerErrors})`
          : 'a SwapKit nao achou rota para o par',
      );
    }
    const preferred = this.deps.config.swapkit.providers;
    for (const provider of preferred) {
      const found = routes.find((route) =>
        (route.providers ?? []).some((name) => name.toUpperCase() === provider.toUpperCase()),
      );
      if (found) return found;
    }
    return routes[0]!;
  }

  private totalFeeBps(route: SwapKitQuoteRoute): number | null {
    const total = (route.fees ?? []).reduce(
      (sum, fee) => sum + (fee.amountBps ?? 0),
      0,
    );
    return total > 0 ? total : null;
  }

  /** Converte o valor fiat em sats pela cotacao do motor. */
  private async resolveAmountSats(input: CreateSwapOrderInput): Promise<bigint> {
    if (this.deps.fx) {
      const client = await this.deps.repos.findClientById(input.clientId);
      const quote = await this.deps.fx.createQuote({
        merchantId: input.clientId,
        amountFiatCents: input.amountFiatCents,
        currency: input.currency,
        spreadBps: client?.spreadBps ?? 0,
        ttlSeconds: this.deps.config.fx.quoteTtlSeconds,
      });
      return quote.amountOut;
    }
    // Sem servico de cotacao nao da para saber quanto BTC o pagador deve
    // enviar: o valor e obrigatorio.
    throw new ServiceUnavailableError('cotacao indisponivel');
  }

  /** Estado do pedido, depois de reconciliar com a SwapKit. */
  async get(id: string, clientId?: string): Promise<SwapOrderDto | null> {
    const order = clientId
      ? await this.deps.repos.findSwapOrderByIdForClient(id, clientId)
      : await this.deps.repos.findSwapOrderById(id);
    if (!order) return null;
    return this.toDto(order);
  }

  /**
   * Reconcilia um pedido com a SwapKit.
   *
   * O provedor diz que entregou; o motor so marca `liquidado` depois de ler
   * a entrega on-chain. Sem prova, o pedido fica esperando ou vai para
   * `manual`.
   */
  async sync(id: string): Promise<SwapOrder | null> {
    const order = await this.deps.repos.findSwapOrderById(id);
    if (!order) return null;
    if (isFinalSwapStatus(order.status)) return order;
    if (!order.depositAddress && !order.depositChannelId) return order;

    let track;
    try {
      track = await this.deps.swapkit.track({
        depositChannelId: order.depositChannelId,
        depositAddress: order.depositAddress,
      });
    } catch (err) {
      await this.deps.repos.updateSwapOrder({
        id: order.id,
        attempts: order.attempts + 1,
        lastCheckedAt: this.now(),
        error: err instanceof Error ? err.message : String(err),
      } as SwapOrderUpdate);
      throw err;
    }

    const providerState = (track.status ?? null) as SwapProviderState | null;
    const mapped = mapSwapKitStatus(providerState);

    if (mapped === 'trocado') {
      // O passo intermediario existe: o provedor pode pular de
      // "aguardando deposito" para "completed" entre dois ciclos, e o motor
      // nao viu o deposito acontecer. O historico guarda as etapas.
      let current = order;
      if (current.status !== 'trocado') {
        current =
          (await this.applyStatus(current, 'trocado', providerState)) ?? current;
      }

      const verified = await this.verifyDelivery(current, track);
      if (verified.kind === 'ok') {
        return this.applyStatus(current, 'liquidado', providerState, {
          providerPayload: {
            ...(current.providerPayload ?? {}),
            track: track as unknown as Record<string, unknown>,
            delivery: verified.detail ?? null,
          },
          error: null,
        });
      }
      if (verified.kind === 'invalid') {
        await this.deps.alerts?.send({
          level: 'error',
          title: 'swap sem prova de entrega',
          message: verified.detail,
          metadata: { swapOrderId: order.id },
        });
        return this.applyStatus(current, 'manual', providerState, {
          error: verified.detail,
        });
      }
      return this.applyStatus(current, 'trocado', providerState, {
        error: verified.detail,
      });
    }

    return this.applyStatus(order, mapped, providerState, {
      providerPayload: {
        ...(order.providerPayload ?? {}),
        track: track as unknown as Record<string, unknown>,
      },
    });
  }

  /**
   * Confere a entrega do USDC na carteira de destino.
   *
   * Com hash de transacao, a prova e o `Transfer` do ERC-20. Sem hash (o
   * trilho de deposito costuma nao devolver), a prova e o saldo grew em
   * relacao a linha de base.
   */
  private async verifyDelivery(
    order: SwapOrder,
    track: { hash?: string | null },
  ) {
    const expected = order.expectedAssetMinor ?? 0n;
    if (expected <= 0n) {
      return { kind: 'invalid' as const, detail: 'valor esperado desconhecido' };
    }
    if (this.deps.verifyDelivery) {
      return this.deps.verifyDelivery(order, track);
    }
    const baseline = this.baselineFrom(order);
    return verifySwapDelivery({
      rpcUrls: this.deps.config.settlement.rpcUrls,
      chainId: this.deps.config.settlement.chainId,
      usdcAddresses: this.deps.config.settlement.usdcAddresses,
      recipient: order.destinationAddress,
      expectedMinor: expected,
      txHash: track.hash ?? null,
      baselineMinor: baseline,
      chainLabel: this.deps.config.settlement.chain,
    });
  }

  private baselineFrom(order: SwapOrder): bigint | null {
    const raw = order.metadata?.['balance_before_minor'];
    if (raw === undefined || raw === null) return null;
    try {
      return BigInt(String(raw));
    } catch {
      return null;
    }
  }

  private async applyStatus(
    order: SwapOrder,
    status: SwapStatus,
    providerState: SwapProviderState | null,
    extra: Partial<SwapOrderUpdate> = {},
  ): Promise<SwapOrder> {
    if (status !== order.status) {
      assertSwapTransition(order.status, status);
    }
    const updated = await this.deps.repos.updateSwapOrder({
      id: order.id,
      status,
      providerState,
      attempts: order.attempts + 1,
      lastCheckedAt: this.now(),
      ...extra,
    } as SwapOrderUpdate);
    return updated ?? order;
  }

  /** Reconcilia os pedidos em aberto (chamado pelo worker). */
  async reconcile(limit: number): Promise<{
    checked: number;
    synced: number;
    errors: number;
    skipped?: boolean;
  }> {
    const cooldown = this.deps.swapkit.rateLimiter?.cooldownRemaining() ?? 0;
    if (cooldown > 0) {
      this.deps.logger.warn(
        { cooldownMs: cooldown },
        'reconciliacao de swap adiada: limite da SwapKit em cooldown',
      );
      return { checked: 0, synced: 0, errors: 0, skipped: true };
    }

    const orders = await this.deps.repos.listSwapOrdersToReconcile(limit);
    let synced = 0;
    let errors = 0;
    for (const order of orders) {
      try {
        await this.sync(order.id);
        synced++;
      } catch (err) {
        errors++;
        this.deps.logger.error(
          { err, swapOrderId: order.id },
          'erro ao reconciliar pedido de swap',
        );
      }
    }
    return { checked: orders.length, synced, errors };
  }

  /** Valor em BTC, usado na resposta e no BIP21. */
  static amountBtc(sats: bigint): string {
    return satsToBtc(sats);
  }
}
