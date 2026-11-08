import { randomUUID } from 'node:crypto';
import { createPublicClient, erc20Abi, fallback, getAddress, http, isAddress } from 'viem';
import type { AppConfig } from '../config.js';
import { decodeCursor, encodeCursor, type DashQueries } from '../db/dash-queries.js';
import type { Repositories } from '../db/repositories.js';
import type { Db } from '../db/client.js';
import { exportRows, toCsv, type ExportKind } from './export-service.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { ApiClient, MerchantWallet, User } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { ClientService } from './client-service.js';
import type { DashAuthService } from './dash-auth-service.js';
import type { EmailSender } from './email-sender.js';
import { deriveRequestStatus, type PaymentRequestRail, type PaymentRequestService } from './payment-request-service.js';
import type { PixChargeService } from './pix-charge-service.js';
import type { LuniumClient } from '../adapters/lunium/client.js';
import type { SwapService } from './swap-service.js';

export type DashServiceDeps = {
  config: AppConfig;
  logger: Logger;
  repos: Repositories;
  queries: DashQueries;
  /** Banco direto, para a exportacao. */
  db?: Db;
  /** Lunium: conferencia publica do comprovante do Pix (e2e). */
  lunium?: Pick<LuniumClient, 'verifyE2e'>;
  clients: ClientService;
  auth: DashAuthService;
  emailSender?: EmailSender;
  pixCharges?: PixChargeService;
  swap?: SwapService;
  paymentRequests?: PaymentRequestService;
  /** Saldo de USDC (unidades minimas) de um endereco; injetavel nos testes. */
  usdcBalanceOf?: (address: string) => Promise<bigint>;
  now?: () => Date;
};

export type PaymentKind = 'pix' | 'bitcoin' | 'request';

export type PaymentListItem = {
  id: string;
  kind: PaymentKind;
  external_id: string;
  status: string;
  amount_cents: string;
  currency: string;
  destination_address: string | null;
  tx_hash: string | null;
  created_at: string;
  paid_at: string | null;
};

export type WalletView = {
  id: string;
  label: string | null;
  address: string;
  chain: string;
  asset: 'USDC';
  is_default: boolean;
  created_at: string;
};

export type StepUpInput = { password: string; request_id?: string | undefined; code?: string | undefined };

const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;
export type OverviewPeriod = keyof typeof PERIOD_DAYS;

/**
 * O painel do lojista. **So consulta e configura**: nada aqui move dinheiro
 * (nao ha saque, envio nem assinatura). Criar link de pagamento so gera o
 * QR que o cliente da loja paga.
 */
export class DashService {
  private readonly now: () => Date;

  constructor(private readonly deps: DashServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** A loja, se o usuario for membro dela. 404 (nao 403) para nao revelar ids. */
  async merchantFor(user: User, merchantId: string): Promise<ApiClient> {
    const member = await this.deps.repos.findMerchantMember(user.id, merchantId);
    if (!member) throw new NotFoundError('loja nao encontrada');
    const client = await this.deps.repos.findClientById(merchantId);
    if (!client || client.clientType !== 'loja') throw new NotFoundError('loja nao encontrada');
    return client;
  }

  private async notifyMembers(merchant: ApiClient, subject: string, text: string): Promise<void> {
    if (!this.deps.emailSender) return;
    const emails = await this.deps.repos.listMerchantMemberEmails(merchant.id);
    for (const to of emails) {
      try {
        await this.deps.emailSender.sendSecurityNotice({ to, subject, text });
      } catch (err) {
        this.deps.logger.warn({ err, merchantId: merchant.id }, 'falha ao enviar aviso de seguranca');
      }
    }
  }

  private async audit(user: User, merchant: ApiClient, action: string, metadata: Record<string, unknown> = {}) {
    await this.deps.repos.insertAuditEvent({
      actor: `painel:${user.id}`,
      action,
      entity: 'api_client',
      entityId: merchant.id,
      metadata,
    });
  }

  // ---------------------------------------------------------------- loja

  async listMerchants(user: User): Promise<ApiClient[]> {
    const rows = await this.deps.repos.listMerchantsForUser(user.id);
    return rows.map((row) => row.client).filter((client) => client.clientType === 'loja');
  }

  merchantView(merchant: ApiClient) {
    return {
      id: merchant.id,
      name: merchant.name,
      status: merchant.status,
      base_currency: merchant.baseCurrency,
      settlement_asset: merchant.settlementAsset,
      settlement_chain: this.deps.config.settlement.chain,
      created_at: merchant.createdAt.toISOString(),
    };
  }

  async updateMerchant(user: User, merchant: ApiClient, input: { name?: string | undefined }) {
    if (input.name === undefined) return this.merchantView(merchant);
    await this.deps.clients.setProfile(merchant.id, { name: input.name }, `painel:${user.id}`);
    return this.merchantView((await this.deps.repos.findClientById(merchant.id))!);
  }

  // ---------------------------------------------------------- visao geral

  async overview(merchant: ApiClient, period: OverviewPeriod) {
    const days = PERIOD_DAYS[period];
    const since = new Date(this.now().getTime() - days * 86_400_000);
    const raw = await this.deps.queries.overview(merchant.id, since);
    const pixTotal = Number(raw.pix?.total ?? 0);
    const pixPaid = Number(raw.pix?.paid ?? 0);
    const swapTotal = Number(raw.swap?.total ?? 0);
    const swapPaid = Number(raw.swap?.paid ?? 0);
    const pixCents = BigInt(raw.pix?.paid_cents ?? 0);
    const swapCents = BigInt(raw.swap?.paid_cents ?? 0);
    const total = pixTotal + swapTotal;
    const paid = pixPaid + swapPaid;
    return {
      period,
      since: since.toISOString(),
      currency: 'BRL',
      received_cents: (pixCents + swapCents).toString(),
      payments_created: total,
      payments_paid: paid,
      conversion_rate: total === 0 ? null : Math.round((paid / total) * 1000) / 10,
      by_rail: [
        { rail: 'pix', created: pixTotal, paid: pixPaid, received_cents: pixCents.toString() },
        { rail: 'bitcoin', created: swapTotal, paid: swapPaid, received_cents: swapCents.toString() },
      ],
      series: raw.series.map((row) => ({
        day: row.day,
        rail: row.rail,
        received_cents: row.paid_cents,
        count: Number(row.count),
      })),
    };
  }

  // ------------------------------------------------------------ pagamentos

  async listPayments(
    merchant: ApiClient,
    input: {
      kind: PaymentKind;
      status?: string[] | undefined;
      externalId?: string | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ): Promise<{ items: PaymentListItem[]; next_cursor: string | null }> {
    const cursor = decodeCursor(input.cursor);
    if (input.cursor && !cursor) throw new ValidationError('cursor invalido');
    const filter = {
      clientId: merchant.id,
      limit: input.limit,
      cursor,
      ...(input.status?.length ? { status: input.status } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
    };

    let rows: Array<{ createdAt: Date; id: string; item: PaymentListItem }>;
    if (input.kind === 'pix') {
      rows = (await this.deps.queries.listPixCharges(filter)).map((row) => ({
        createdAt: row.createdAt,
        id: row.id,
        item: {
          id: row.id,
          kind: 'pix',
          external_id: row.externalId,
          status: row.status,
          amount_cents: row.amountBrlCents.toString(),
          currency: 'BRL',
          destination_address: row.destinationAddress,
          tx_hash: row.settlementTxHash,
          created_at: row.createdAt.toISOString(),
          paid_at: row.paidAt?.toISOString() ?? null,
        },
      }));
    } else if (input.kind === 'bitcoin') {
      rows = (await this.deps.queries.listSwapOrders(filter)).map((row) => ({
        createdAt: row.createdAt,
        id: row.id,
        item: {
          id: row.id,
          kind: 'bitcoin',
          external_id: row.externalId,
          status: row.status,
          amount_cents: row.amountFiatCents.toString(),
          currency: row.currency,
          destination_address: row.destinationAddress,
          tx_hash: row.deliveryTxHash,
          created_at: row.createdAt.toISOString(),
          paid_at: row.status === 'liquidado' ? row.updatedAt.toISOString() : null,
        },
      }));
    } else {
      const { status: _ignored, ...requestFilter } = filter;
      rows = (await this.deps.queries.listPaymentRequests(requestFilter))
        .map(({ request, pixStatus, swapStatus }) => {
          const derived = deriveRequestStatus({
            stored: request.status,
            pix: pixStatus,
            bitcoin: swapStatus,
            hasPixDirect: request.pixDirect !== null,
          });
          return {
            createdAt: request.createdAt,
            id: request.id,
            item: {
              id: request.id,
              kind: 'request' as const,
              external_id: request.externalId,
              status: derived.status,
              amount_cents: request.amountFiatCents.toString(),
              currency: request.currency,
              destination_address: null,
              tx_hash: null,
              created_at: request.createdAt.toISOString(),
              paid_at: null,
            },
          };
        })
        .filter((row) => !input.status?.length || input.status.includes(row.item.status));
    }

    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => row.item),
      next_cursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    };
  }

  async paymentDetail(merchant: ApiClient, kind: PaymentKind, id: string) {
    if (kind === 'pix') {
      if (!this.deps.pixCharges) throw new NotFoundError('cobranca nao encontrada');
      const charge = await this.deps.pixCharges.getById(merchant.id, id);
      const events = await this.deps.queries.listWebhookEvents(merchant.id, { pixChargeId: id, limit: 50 });
      return { kind, payment: charge, webhooks: events.map((e) => this.webhookView(e)) };
    }
    if (kind === 'bitcoin') {
      const swap = this.deps.swap ? await this.deps.swap.get(id, merchant.id) : null;
      if (!swap) throw new NotFoundError('pedido nao encontrado');
      return { kind, payment: swap, webhooks: [] };
    }
    const request = this.deps.paymentRequests ? await this.deps.paymentRequests.get(id, merchant.id) : null;
    if (!request) throw new NotFoundError('pedido nao encontrado');
    return { kind, payment: request, webhooks: [] };
  }

  /**
   * Comprovante oficial de um Pix recebido (cash-in), conferido na Lunium
   * pelo e2e do Banco Central.
   */
  async pixReceipt(merchant: ApiClient, id: string) {
    if (!this.deps.lunium) throw new NotFoundError('comprovante indisponivel');
    const charge = await this.deps.repos.findPixChargeByIdForClient(id, merchant.id);
    if (!charge) throw new NotFoundError('cobranca nao encontrada');
    if (!charge.e2e) throw new NotFoundError('este Pix ainda nao tem comprovante');
    const found = await this.deps.lunium.verifyE2e(charge.e2e);
    if (!found) return { verified: false, e2e: charge.e2e };
    return {
      verified: found.verificado && found.pago,
      e2e: found.e2e,
      amount_brl: found.valor_brl ?? null,
      paid_at: found.pago_em ?? null,
      institution: found.instituicao ?? null,
      receipt_url: found.comprovante_url ?? null,
    };
  }

  // ------------------------------------------------------ links de pagamento

  async createPaymentLink(
    user: User,
    merchant: ApiClient,
    input: {
      amountCents: bigint;
      currency: 'BRL' | 'USD';
      rails: PaymentRequestRail[];
      description?: string | undefined;
      externalId?: string | undefined;
      walletId?: string | undefined;
      payerTaxNumber?: string | undefined;
    },
  ) {
    if (!this.deps.paymentRequests) throw new ForbiddenError('links de pagamento indisponiveis');
    // Mensagem clara antes de tentar: o 503 do servico sai como "erro interno".
    if (input.rails.includes('bitcoin') && !this.deps.swap) {
      throw new ValidationError('pagamento em Bitcoin indisponivel no momento');
    }
    if (input.rails.includes('pix') && !this.deps.pixCharges) {
      throw new ValidationError('Pix indisponivel no momento');
    }
    let destinationAddress: string | undefined;
    if (input.walletId) {
      const wallet = await this.deps.queries.findSettlementWallet(merchant.id, input.walletId);
      if (!wallet) throw new ValidationError('carteira nao encontrada');
      destinationAddress = wallet.address;
    }
    const externalId = input.externalId ?? `painel_${randomUUID()}`;
    const { dto } = await this.deps.paymentRequests.create({
      clientId: merchant.id,
      externalId,
      amountFiatCents: input.amountCents,
      currency: input.currency,
      rails: input.rails,
      ...(input.description ? { description: input.description } : {}),
      ...(input.payerTaxNumber ? { payerTaxNumber: input.payerTaxNumber } : {}),
      ...(destinationAddress ? { destinationAddress } : {}),
      metadata: { source: 'painel', user_id: user.id },
    });
    const base = this.deps.config.service.publicBaseUrl.replace(/\/+$/, '');
    // A pagina publica de cada trilho: Pix (cobranca da Lunium) ou o pedido.
    const payUrl = dto.options.pix?.charge_id ? `${base}/pay/${dto.options.pix.charge_id}` : null;
    return { ...dto, pay_url: payUrl };
  }

  // -------------------------------------------------------------- carteiras

  private walletView(
    wallet: Pick<MerchantWallet, 'id' | 'address' | 'chain' | 'createdAt'> & { label: string | null; isDefault: boolean },
  ): WalletView {
    return {
      id: wallet.id,
      label: wallet.label ?? null,
      address: getAddress(wallet.address),
      chain: wallet.chain,
      asset: 'USDC',
      is_default: wallet.isDefault,
      created_at: wallet.createdAt.toISOString(),
    };
  }

  async listWallets(merchant: ApiClient): Promise<WalletView[]> {
    const rows = await this.deps.queries.listSettlementWallets(merchant.id);
    return rows.map((row) => this.walletView(row));
  }

  async addWallet(
    user: User,
    merchant: ApiClient,
    input: { address: string; label?: string | undefined; stepUp: StepUpInput },
  ): Promise<WalletView> {
    // Aceita tudo minusculo ou tudo maiusculo; misturado, o checksum EIP-55
    // tem de conferir (pega erro de digitacao).
    const raw = input.address.trim();
    const hex = raw.slice(2);
    const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
    if (!isAddress(raw, { strict: false }) || (mixed && !isAddress(raw, { strict: true }))) {
      throw new ValidationError('endereco invalido: confira o endereco da carteira (0x...)');
    }
    const address = raw.toLowerCase();
    if (address === '0x0000000000000000000000000000000000000000') {
      throw new ValidationError('endereco invalido');
    }
    await this.deps.auth.assertStepUp(user, {
      password: input.stepUp.password,
      requestId: input.stepUp.request_id,
      code: input.stepUp.code,
    });
    const chain = this.deps.config.settlement.chain;
    const result = await this.deps.queries.addSettlementWallet({
      clientId: merchant.id,
      chain,
      network: chain,
      address,
      label: input.label?.trim() || null,
    });
    if (result.conflict) throw new ConflictError('este endereco ja esta cadastrado');
    await this.audit(user, merchant, 'wallet.added', { walletId: result.wallet.id, address });
    await this.notifyMembers(
      merchant,
      'Carteira de recebimento cadastrada',
      `A carteira ${getAddress(address)} (${chain}) foi cadastrada na loja ${merchant.name}` +
        (result.wallet.isDefault ? ' e passou a receber os pagamentos.' : '.') +
        ' Se nao foi voce, entre no painel, remova a carteira e troque sua senha.',
    );
    return this.walletView(result.wallet);
  }

  async setDefaultWallet(user: User, merchant: ApiClient, walletId: string, stepUp: StepUpInput) {
    const wallet = await this.deps.queries.findSettlementWallet(merchant.id, walletId);
    if (!wallet) throw new NotFoundError('carteira nao encontrada');
    await this.deps.auth.assertStepUp(user, { password: stepUp.password, requestId: stepUp.request_id, code: stepUp.code });
    await this.deps.queries.setDefaultSettlementWallet(merchant.id, wallet.id, wallet.chain);
    await this.audit(user, merchant, 'wallet.default_changed', { walletId: wallet.id, address: wallet.address });
    await this.notifyMembers(
      merchant,
      'Carteira padrao de recebimento alterada',
      `Os pagamentos da loja ${merchant.name} passam a cair na carteira ${getAddress(wallet.address)}. ` +
        'Se nao foi voce, entre no painel, volte a carteira anterior e troque sua senha.',
    );
    return this.listWallets(merchant);
  }

  async renameWallet(merchant: ApiClient, walletId: string, label: string | null) {
    const wallet = await this.deps.queries.findSettlementWallet(merchant.id, walletId);
    if (!wallet) throw new NotFoundError('carteira nao encontrada');
    await this.deps.queries.renameSettlementWallet(merchant.id, wallet.id, label?.trim() || null);
    return this.listWallets(merchant);
  }

  async removeWallet(user: User, merchant: ApiClient, walletId: string, stepUp: StepUpInput) {
    const wallet = await this.deps.queries.findSettlementWallet(merchant.id, walletId);
    if (!wallet) throw new NotFoundError('carteira nao encontrada');
    await this.deps.auth.assertStepUp(user, { password: stepUp.password, requestId: stepUp.request_id, code: stepUp.code });
    await this.deps.queries.removeSettlementWallet(merchant.id, wallet.id, wallet.chain);
    await this.audit(user, merchant, 'wallet.removed', { walletId: wallet.id, address: wallet.address });
    await this.notifyMembers(
      merchant,
      'Carteira de recebimento removida',
      `A carteira ${getAddress(wallet.address)} foi removida da loja ${merchant.name}.`,
    );
    return this.listWallets(merchant);
  }

  /** Saldo on-chain so para leitura (nativo + bridged somados). */
  async walletBalance(merchant: ApiClient, walletId: string) {
    const wallet = await this.deps.queries.findSettlementWallet(merchant.id, walletId);
    if (!wallet) throw new NotFoundError('carteira nao encontrada');
    const balanceOf = this.deps.usdcBalanceOf ?? this.defaultBalanceOf();
    const minor = await balanceOf(wallet.address);
    return { wallet_id: wallet.id, asset: 'USDC', decimals: 6, balance_minor: minor.toString() };
  }

  private defaultBalanceOf(): (address: string) => Promise<bigint> {
    const settlement = this.deps.config.settlement;
    const client = createPublicClient({
      transport: fallback(settlement.rpcUrls.map((url) => http(url, { timeout: 10_000 }))),
    });
    return async (address) => {
      let total = 0n;
      for (const contract of settlement.usdcAddresses) {
        total += await client.readContract({
          address: contract as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address as `0x${string}`],
        });
      }
      return total;
    };
  }

  /** Aviso aos membros quando o banco do Pix direto muda. */
  async notifyBankChange(merchant: ApiClient): Promise<void> {
    await this.notifyMembers(
      merchant,
      'Banco do Pix alterado',
      `A conta bancaria que recebe o Pix da loja ${merchant.name} foi configurada ou alterada no painel. ` +
        'Se nao foi voce, entre no painel, remova a configuracao e troque sua senha.',
    );
  }

  // ------------------------------------------------------------ exportacao

  /** CSV das vendas no periodo (no maximo 366 dias), para o contador. */
  async exportCsv(merchant: ApiClient, input: { kind: ExportKind; from: Date; to: Date }): Promise<string> {
    if (!this.deps.db) throw new ValidationError('exportacao indisponivel');
    if (input.to.getTime() < input.from.getTime()) throw new ValidationError('periodo invalido');
    if (input.to.getTime() - input.from.getTime() > 366 * 86_400_000) {
      throw new ValidationError('exporte no maximo um ano por vez');
    }
    return toCsv(await exportRows(this.deps.db, merchant.id, input));
  }

  // ------------------------------------------------------------- integracao

  integrationView(merchant: ApiClient) {
    return {
      api_key_prefix: merchant.apiKeyPrefix,
      webhook_url: merchant.webhookUrl || null,
      api_base_url: this.deps.config.service.publicBaseUrl.replace(/\/+$/, ''),
      scopes: merchant.scopes,
    };
  }

  /**
   * Gera chave de API, segredo de assinatura e segredo do webhook novos. Os
   * tres saem **so nesta resposta**; os anteriores param de valer na hora.
   */
  async rotateCredentials(user: User, merchant: ApiClient, stepUp: StepUpInput) {
    await this.deps.auth.assertStepUp(user, { password: stepUp.password, requestId: stepUp.request_id, code: stepUp.code });
    const creds = await this.deps.clients.rotateCredentials(merchant.id, `painel:${user.id}`);
    await this.notifyMembers(
      merchant,
      'Nova chave de API gerada',
      `Uma nova chave de API foi gerada para a loja ${merchant.name}; a anterior parou de funcionar. ` +
        'Se nao foi voce, gere outra no painel e troque sua senha.',
    );
    return {
      api_key: creds.apiKey,
      request_secret: creds.requestSecret,
      webhook_secret: creds.webhookSecret,
    };
  }

  async setWebhookUrl(user: User, merchant: ApiClient, url: string | null) {
    await this.deps.clients.setProfile(merchant.id, { webhookUrl: url ?? '' }, `painel:${user.id}`);
    return this.integrationView((await this.deps.repos.findClientById(merchant.id))!);
  }

  /** Evento `ping` pela fila normal, com a mesma assinatura dos reais. */
  async sendTestWebhook(merchant: ApiClient) {
    if (!merchant.webhookUrl) throw new ValidationError('cadastre a URL do webhook antes de testar');
    const eventId = randomUUID();
    const event = await this.deps.repos.insertWebhookEvent({
      clientId: merchant.id,
      eventType: 'ping',
      dedupeKey: `ping:${eventId}`,
      payload: {
        event: 'ping',
        event_id: eventId,
        created_at: this.now().toISOString(),
        data: { merchant_id: merchant.id, message: 'teste do painel' },
      },
    });
    if (!event) throw new ConflictError('evento de teste duplicado');
    return this.webhookView(event);
  }

  async listWebhookEvents(merchant: ApiClient, limit: number) {
    const rows = await this.deps.queries.listWebhookEvents(merchant.id, { limit });
    return rows.map((row) => this.webhookView(row));
  }

  async replayWebhook(merchant: ApiClient, eventId: string) {
    const event = await this.deps.queries.findWebhookEvent(merchant.id, eventId);
    if (!event) throw new NotFoundError('evento nao encontrado');
    const replayed = await this.deps.repos.replayWebhookEvent(event.id);
    return this.webhookView(replayed ?? event);
  }

  private webhookView(event: {
    id: string;
    eventType: string;
    status: string;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    deliveredAt: Date | null;
    nextAttemptAt: Date;
  }) {
    return {
      id: event.id,
      event: event.eventType,
      status: event.status,
      attempts: event.attempts,
      last_error: event.lastError,
      created_at: event.createdAt.toISOString(),
      delivered_at: event.deliveredAt?.toISOString() ?? null,
      next_attempt_at: event.status === 'pendente' ? event.nextAttemptAt.toISOString() : null,
    };
  }
}
