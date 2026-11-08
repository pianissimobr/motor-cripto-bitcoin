import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
import { getAddress } from 'viem';
import type { AppConfig } from '../config.js';
import { encryptSecret } from '../crypto/cipher.js';
import { sha256Hex } from '../crypto/hmac.js';
import type { Db } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { invoices, storeKeys, type InvoiceStatus } from '../db/schema.js';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../domain/errors.js';
import type { ApiClient, PixChargeStatus, SwapStatus } from '../domain/types.js';
import type { Logger } from '../logger.js';
import { assertWebhookUrl, defaultHostLookup, type HostLookup } from '../net/webhook-url.js';
import type { PixChargeService } from './pix-charge-service.js';
import { normalizePayerTax } from './pix-charge-service.js';
import type { SwapService } from './swap-service.js';
import { createSwapDeliveryChain, type SwapDeliveryChain } from '../adapters/chain/swap-delivery-verify.js';

export type StoreKeyMode = 'live' | 'test';
export type InvoiceRow = typeof invoices.$inferSelect;
export type StoreKeyRow = typeof storeKeys.$inferSelect;
export type InvoiceRail = 'pix' | 'bitcoin' | 'usdc' | 'pix_direto';

export type PublicPayment =
  | { rail: 'pix'; qr_copypaste: string; qr_svg: string; test: boolean }
  | { rail: 'pix_direto'; qr_copypaste: string; qr_svg: string; test: boolean }
  | { rail: 'bitcoin'; address: string; amount_btc: string; bip21: string; qr_svg: string; test: boolean }
  | {
      rail: 'usdc';
      address: string;
      amount_usdc: string;
      network: string;
      token: string;
      uri: string;
      qr_svg: string;
      test: boolean;
    };

/** O que a fatura precisa do Pix direto (implementado em pix-direto-service). */
export type PixDiretoGateway = {
  isConfigured(clientId: string): Promise<boolean>;
  createCharge(input: {
    clientId: string;
    txid: string;
    amountCents: bigint;
    description: string;
    expiresInSeconds: number;
  }): Promise<{ copypaste: string }>;
  checkPaid(clientId: string, txid: string): Promise<{ paid: boolean; txHash: string | null }>;
};

/** Preco do BTC em centavos, na moeda pedida (a cotacao dolar/real sai dai). */
export type BtcPriceSource = { getBtcPrice(currency: 'BRL' | 'USD'): Promise<{ btcPriceCents: bigint }> };

/** Unidades minimas de USDC (6 casas) -> "18.430027". */
export function formatUsdc(minor: bigint): string {
  return `${minor / 1_000_000n}.${(minor % 1_000_000n).toString().padStart(6, '0')}`;
}

/**
 * Valor da fatura em USDC: dolar direto ou real convertido pelo preco do BTC
 * nas duas moedas (mesma fonte), arredondado para cima ate o centavo (a loja
 * nao recebe menos que o pedido).
 */
export function usdcMinorFor(amountCents: bigint, currency: 'BRL' | 'USD', prices?: { brl: bigint; usd: bigint }): bigint {
  let minor: bigint;
  if (currency === 'USD') {
    minor = amountCents * 10_000n;
  } else {
    if (!prices || prices.brl <= 0n || prices.usd <= 0n) throw new ValidationError('cotacao do dolar indisponivel');
    const numerator = amountCents * prices.usd * 10_000n;
    minor = (numerator + prices.brl - 1n) / prices.brl;
  }
  return ((minor + 9_999n) / 10_000n) * 10_000n;
}

export type InvoiceServiceDeps = {
  db: Db;
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  pixCharges?: PixChargeService;
  swap?: SwapService;
  /** Rede para o trilho USDC direto (injetavel nos testes). */
  chain?: Pick<SwapDeliveryChain, 'getBlockNumber' | 'getTransferLogs'>;
  /** Preco do BTC em real e em dolar: da a cotacao para a fatura em real. */
  prices?: BtcPriceSource;
  /** Pix na conta da propria loja, pela API Pix do banco dela. */
  pixDireto?: PixDiretoGateway;
  /** Resolucao de DNS do ipn_callback_url (injetavel nos testes). */
  lookupHost?: HostLookup;
  now?: () => Date;
};

export type CreateInvoiceInput = {
  priceAmount: string;
  priceCurrency: 'BRL' | 'USD';
  orderId: string;
  orderDescription?: string | undefined;
  customerEmail?: string | undefined;
  successUrl?: string | undefined;
  cancelUrl?: string | undefined;
  ipnCallbackUrl?: string | undefined;
  rails?: InvoiceRail[] | undefined;
  expiresInMinutes?: number | undefined;
};

/** Decimal das plataformas ("99.90", "99,9", "100") -> centavos, sem float. */
export function priceToCents(value: string): bigint {
  const match = /^(\d{1,12})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new ValidationError('price_amount invalido: use 99.90');
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (cents <= 0n) throw new ValidationError('price_amount deve ser maior que zero');
  return cents;
}

function centsToDecimal(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

const FINAL: InvoiceStatus[] = ['pago', 'expirado', 'cancelado'];

/**
 * Estado da fatura a partir das cobrancas que o pagador abriu.
 *
 * - `pago`: Pix pago na Lunium (ou liquidado) ou swap com o USDC entregue;
 * - `confirmando`: o Bitcoin chegou e esta sendo convertido (ou o Pix esta em
 *   conferencia): o dinheiro ja saiu do pagador, entao nao expira;
 * - `expirado`: passou da validade sem nada em andamento.
 */
export function deriveInvoiceStatus(input: {
  current: InvoiceStatus;
  pix: PixChargeStatus | null;
  bitcoin: SwapStatus | null;
  /** Transferencia de USDC com o valor exato, ja confirmada e reservada. */
  usdcPaid?: boolean;
  /** Cobranca no banco da loja (API Pix) concluida. */
  pixDiretoPaid?: boolean;
  expiresAt: Date;
  now: Date;
}): { status: InvoiceStatus; paidRail: InvoiceRail | null } {
  if (FINAL.includes(input.current) && input.current !== 'expirado') {
    return { status: input.current, paidRail: null };
  }
  if (input.usdcPaid) return { status: 'pago', paidRail: 'usdc' };
  if (input.pixDiretoPaid) return { status: 'pago', paidRail: 'pix_direto' };
  if (input.pix === 'pago' || input.pix === 'liquidado') return { status: 'pago', paidRail: 'pix' };
  if (input.bitcoin === 'liquidado') return { status: 'pago', paidRail: 'bitcoin' };
  const inFlight =
    input.bitcoin === 'depositado' ||
    input.bitcoin === 'trocado' ||
    input.bitcoin === 'incerto' ||
    input.bitcoin === 'manual' ||
    input.pix === 'incerto' ||
    input.pix === 'manual';
  if (inFlight) return { status: 'confirmando', paidRail: null };
  if (input.now.getTime() >= input.expiresAt.getTime()) return { status: 'expirado', paidRail: null };
  return { status: 'aguardando', paidRail: null };
}

/**
 * Faturas hospedadas e chaves de loja: a camada "plug and play" para
 * WooCommerce, Shopify e afins. A plataforma cria a fatura, manda o cliente
 * para `invoice_url` e recebe o IPN quando muda o estado.
 */
export class InvoiceService {
  private readonly now: () => Date;

  constructor(private readonly deps: InvoiceServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private baseUrl(): string {
    return this.deps.config.service.publicBaseUrl.replace(/\/+$/, '');
  }

  // ------------------------------------------------------------ chaves

  /** Cria a chave e o segredo IPN. Os dois saem **so nesta resposta**. */
  async createStoreKey(clientId: string, mode: StoreKeyMode, label?: string | null, actor = 'painel') {
    const apiKey = `mk_store_${mode}_${randomBytes(24).toString('base64url')}`;
    const ipnSecret = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const kid = this.deps.config.crypto.activeKid;
    const key = this.deps.config.crypto.keyring[kid];
    if (!key) throw new Error('chave ativa de cifragem ausente');
    const rows = await this.deps.db
      .insert(storeKeys)
      .values({
        id,
        clientId,
        mode,
        label: label?.trim() || null,
        keyPrefix: apiKey.slice(0, 22),
        keyHash: sha256Hex(apiKey),
        ipnSecretEnc: encryptSecret(ipnSecret, key, kid, id),
      })
      .returning();
    await this.deps.repos.insertAuditEvent({
      actor,
      action: 'store_key.created',
      entity: 'api_client',
      entityId: clientId,
      metadata: { storeKeyId: id, mode },
    });
    return { key: this.storeKeyView(rows[0]!), api_key: apiKey, ipn_secret: ipnSecret };
  }

  storeKeyView(row: StoreKeyRow) {
    return {
      id: row.id,
      mode: row.mode,
      label: row.label,
      key_prefix: row.keyPrefix,
      created_at: row.createdAt.toISOString(),
      last_used_at: row.lastUsedAt?.toISOString() ?? null,
    };
  }

  async listStoreKeys(clientId: string) {
    const rows = await this.deps.db
      .select()
      .from(storeKeys)
      .where(and(eq(storeKeys.clientId, clientId), isNull(storeKeys.revokedAt)))
      .orderBy(desc(storeKeys.createdAt));
    return rows.map((row) => this.storeKeyView(row));
  }

  async revokeStoreKey(clientId: string, id: string, actor = 'painel') {
    const rows = await this.deps.db
      .update(storeKeys)
      .set({ revokedAt: this.now() })
      .where(and(eq(storeKeys.id, id), eq(storeKeys.clientId, clientId), isNull(storeKeys.revokedAt)))
      .returning({ id: storeKeys.id });
    if (rows.length === 0) throw new NotFoundError('chave nao encontrada');
    await this.deps.repos.insertAuditEvent({
      actor,
      action: 'store_key.revoked',
      entity: 'api_client',
      entityId: clientId,
      metadata: { storeKeyId: id },
    });
  }

  /** `x-api-key` -> chave ativa e loja ativa. Erro unico para nao revelar qual falhou. */
  async authenticate(apiKey: string): Promise<{ key: StoreKeyRow; client: ApiClient }> {
    const invalid = new UnauthorizedError('chave de loja invalida');
    if (!/^mk_store_(live|test)_[A-Za-z0-9_-]{20,64}$/.test(apiKey)) throw invalid;
    const rows = await this.deps.db
      .select()
      .from(storeKeys)
      .where(eq(storeKeys.keyHash, sha256Hex(apiKey)))
      .limit(1);
    const key = rows[0];
    if (!key || key.revokedAt) throw invalid;
    const client = await this.deps.repos.findClientById(key.clientId);
    if (!client || client.status !== 'ativo' || client.clientType !== 'loja') throw invalid;
    // Marca o uso no maximo uma vez por minuto (a tela mostra "ultimo uso").
    if (!key.lastUsedAt || this.now().getTime() - key.lastUsedAt.getTime() > 60_000) {
      await this.deps.db.update(storeKeys).set({ lastUsedAt: this.now() }).where(eq(storeKeys.id, key.id));
    }
    return { key, client };
  }

  // ------------------------------------------------------------ faturas

  private async checkUrl(value: string | undefined, field: string): Promise<string | null> {
    if (!value) return null;
    const isProduction = this.deps.config.service.isProduction;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ValidationError(`${field} invalida`);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !isProduction)) {
      throw new ValidationError(`${field} precisa ser https`);
    }
    if (url.username || url.password) throw new ValidationError(`${field} nao pode ter usuario e senha`);
    return url.toString();
  }

  /** Cria a fatura; o mesmo `order_id` (por loja e modo) devolve a mesma. */
  async create(client: ApiClient, key: StoreKeyRow | null, mode: StoreKeyMode, input: CreateInvoiceInput) {
    const orderId = input.orderId.trim();
    const existing = await this.findByOrder(client.id, mode, orderId);
    if (existing) return { invoice: await this.sync(existing), reused: true };

    const amountCents = priceToCents(input.priceAmount);
    const rails = [...new Set(input.rails ?? (await this.defaultRails(client.id, mode)))];
    for (const rail of ['pix', 'pix_direto'] as const) {
      if (input.priceCurrency !== 'BRL' && rails.includes(rail)) {
        // Pix e em real; em dolar so Bitcoin e USDC.
        if (input.rails?.includes(rail)) throw new ValidationError('Pix so aceita price_currency BRL');
        rails.splice(rails.indexOf(rail), 1);
      }
    }
    if (rails.length === 0) throw new ValidationError('nenhum meio de pagamento disponivel');
    if (mode === 'live') {
      const wallet = await this.deps.repos.findActiveUsdcSettlementWalletForClient(client.id);
      if (!wallet && !client.settlementAddress) {
        throw new ValidationError('cadastre a carteira de recebimento no painel antes de cobrar');
      }
    }

    const ipnUrl = await this.checkUrl(input.ipnCallbackUrl, 'ipn_callback_url');
    if (ipnUrl) {
      // A mesma protecao do webhook: nada de rede interna.
      try {
        await assertWebhookUrl(ipnUrl, {
          requireHttps: this.deps.config.service.isProduction,
          lookupHost: this.deps.lookupHost ?? defaultHostLookup,
          allowLoopback: !this.deps.config.service.isProduction,
        });
      } catch {
        throw new ValidationError('ipn_callback_url invalida ou aponta para a rede interna');
      }
    }

    const minutes = Math.min(Math.max(input.expiresInMinutes ?? 60, 15), 24 * 60);
    try {
      const rows = await this.deps.db
        .insert(invoices)
        .values({
          clientId: client.id,
          storeKeyId: key?.id ?? null,
          mode,
          orderId,
          amountCents,
          currency: input.priceCurrency,
          description: input.orderDescription?.trim() || null,
          customerEmail: input.customerEmail?.trim() || null,
          successUrl: await this.checkUrl(input.successUrl, 'success_url'),
          cancelUrl: await this.checkUrl(input.cancelUrl, 'cancel_url'),
          ipnUrl,
          rails,
          expiresAt: new Date(this.now().getTime() + minutes * 60_000),
        })
        .returning();
      return { invoice: rows[0]!, reused: false };
    } catch (err) {
      // Corrida entre duas criacoes com o mesmo order_id.
      const again = await this.findByOrder(client.id, mode, orderId);
      if (again) return { invoice: again, reused: true };
      throw err;
    }
  }

  /** Trilhos oferecidos quando a plataforma nao escolhe: o que esta ligado. */
  async defaultRails(clientId: string, mode: StoreKeyMode): Promise<InvoiceRail[]> {
    const rails: InvoiceRail[] = [];
    const bank = mode === 'live' && this.deps.pixDireto ? await this.deps.pixDireto.isConfigured(clientId) : false;
    // Com o banco da loja ligado, o Pix cai em reais na conta dela.
    if (bank) rails.push('pix_direto');
    else if (this.deps.pixCharges || mode === 'test') rails.push('pix');
    if (this.deps.swap || mode === 'test') rails.push('bitcoin');
    rails.push('usdc');
    return rails;
  }

  async findByOrder(clientId: string, mode: StoreKeyMode, orderId: string): Promise<InvoiceRow | null> {
    const rows = await this.deps.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.clientId, clientId), eq(invoices.mode, mode), eq(invoices.orderId, orderId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findForClient(clientId: string, id: string): Promise<InvoiceRow | null> {
    const rows = await this.deps.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.clientId, clientId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findPublic(id: string): Promise<InvoiceRow | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const rows = await this.deps.db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Corpo devolvido pela API e enviado no IPN (o plugin confere por ele). */
  dto(row: InvoiceRow) {
    return {
      id: row.id,
      order_id: row.orderId,
      mode: row.mode,
      status: row.status,
      price_amount: centsToDecimal(row.amountCents),
      price_currency: row.currency,
      order_description: row.description,
      invoice_url: `${this.baseUrl()}/i/${row.id}`,
      rails: row.rails,
      paid_rail: row.paidRail,
      tx_hash: row.txHash,
      expires_at: row.expiresAt.toISOString(),
      paid_at: row.paidAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  /**
   * Recalcula o estado pelas cobrancas e, se mudou, grava e enfileira o IPN.
   * Idempotente: chamado na leitura, pela pagina e pelo job do worker.
   */
  async sync(row: InvoiceRow): Promise<InvoiceRow> {
    if (row.mode === 'test') {
      // Teste: so a simulacao muda o estado; a validade continua valendo.
      if (row.status === 'aguardando' && this.now() >= row.expiresAt) return this.transition(row, 'expirado', null, null);
      return row;
    }
    if (row.status === 'pago' || row.status === 'cancelado') return row;
    let usdc: { paid: boolean; txHash: string | null } = { paid: Boolean(row.usdcTxHash), txHash: row.usdcTxHash };
    if (!usdc.paid && row.usdcAmountMinor !== null) {
      usdc = await this.scanUsdc(row);
    }
    let pixDireto: { paid: boolean; txHash: string | null } = { paid: false, txHash: null };
    if (row.pixDiretoTxid && this.deps.pixDireto) {
      pixDireto = await this.deps.pixDireto.checkPaid(row.clientId, row.pixDiretoTxid);
    }
    let pix: PixChargeStatus | null = null;
    let pixTx: string | null = null;
    let bitcoin: SwapStatus | null = null;
    let swapTx: string | null = null;
    if (row.pixChargeId) {
      const charge = await this.deps.repos.findPixChargeById(row.pixChargeId);
      pix = charge?.status ?? null;
      pixTx = charge?.settlementTxHash ?? null;
    }
    if (row.swapOrderId) {
      const order = await this.deps.repos.findSwapOrderById(row.swapOrderId);
      bitcoin = order?.status ?? null;
      swapTx = order?.deliveryTxHash ?? null;
    }
    const next = deriveInvoiceStatus({
      current: row.status,
      pix,
      bitcoin,
      usdcPaid: usdc.paid,
      pixDiretoPaid: pixDireto.paid,
      expiresAt: row.expiresAt,
      now: this.now(),
    });
    const txHash =
      next.paidRail === 'pix'
        ? pixTx
        : next.paidRail === 'bitcoin'
          ? swapTx
          : next.paidRail === 'usdc'
            ? usdc.txHash
            : next.paidRail === 'pix_direto'
              ? pixDireto.txHash
              : row.txHash;
    if (next.status === row.status && txHash === row.txHash) return row;
    return this.transition(row, next.status, next.paidRail, txHash);
  }

  private async transition(
    row: InvoiceRow,
    status: InvoiceStatus,
    paidRail: InvoiceRail | null,
    txHash: string | null,
  ): Promise<InvoiceRow> {
    const now = this.now();
    // Condicional no estado lido: duas sincronizacoes ao mesmo tempo geram
    // um IPN so.
    const rows = await this.deps.db
      .update(invoices)
      .set({
        status,
        ...(paidRail ? { paidRail } : {}),
        txHash,
        ...(status === 'pago' && !row.paidAt ? { paidAt: now } : {}),
        updatedAt: now,
      })
      .where(and(eq(invoices.id, row.id), eq(invoices.status, row.status)))
      .returning();
    const updated = rows[0];
    if (!updated) {
      return (await this.findPublic(row.id)) ?? row;
    }
    if (updated.status !== row.status) await this.enqueueIpn(updated);
    return updated;
  }

  private chain(): Pick<SwapDeliveryChain, 'getBlockNumber' | 'getTransferLogs'> {
    if (!this.deps.chain) {
      this.deps.chain = createSwapDeliveryChain({
        rpcUrls: this.deps.config.settlement.rpcUrls,
        chainId: this.deps.config.settlement.chainId,
        chainLabel: this.deps.config.settlement.chain,
      });
    }
    return this.deps.chain;
  }

  /**
   * Procura a transferencia de USDC com o valor exato para a carteira da
   * loja, a partir do bloco em que o pagador escolheu USDC e so em blocos com
   * a profundidade minima. Achou: reserva a transferencia (uma fatura por
   * transferencia) e devolve o hash.
   */
  private async scanUsdc(row: InvoiceRow): Promise<{ paid: boolean; txHash: string | null }> {
    const none = { paid: false, txHash: null };
    if (row.usdcAmountMinor === null || !row.usdcAddress || row.usdcStartBlock === null) return none;
    const chain = this.chain();
    let latest: bigint;
    try {
      latest = await chain.getBlockNumber();
    } catch {
      return none;
    }
    const depth = BigInt(Math.max(1, this.deps.config.settlement.confirmations));
    const deep = latest - (depth - 1n);
    let from = row.usdcScannedBlock !== null ? row.usdcScannedBlock + 1n : row.usdcStartBlock;
    // No maximo 20 mil blocos por rodada; a proxima continua dali.
    const end = deep < from + 20_000n ? deep : from + 20_000n;
    if (end < from) return none;
    const contracts = this.deps.config.settlement.usdcAddresses.map((a) => a.toLowerCase());
    for (; from <= end; from += 1_000n) {
      const to = from + 999n < end ? from + 999n : end;
      let logs;
      try {
        logs = await chain.getTransferLogs({ contracts, recipient: row.usdcAddress, fromBlock: from, toBlock: to });
      } catch {
        return none;
      }
      for (const log of logs) {
        if (log.value !== row.usdcAmountMinor) continue;
        if (await this.deps.repos.isSwapDeliveryClaimed(log.transactionHash, log.logIndex)) continue;
        try {
          const claimed = await this.deps.db
            .update(invoices)
            .set({ usdcTxHash: log.transactionHash.toLowerCase(), usdcLogIndex: log.logIndex, usdcScannedBlock: to, updatedAt: this.now() })
            .where(and(eq(invoices.id, row.id), isNull(invoices.usdcTxHash)))
            .returning({ id: invoices.id });
          if (claimed.length > 0) return { paid: true, txHash: log.transactionHash.toLowerCase() };
        } catch {
          // Outra fatura levou esta transferencia (indice unico): segue.
          continue;
        }
      }
      await this.deps.db.update(invoices).set({ usdcScannedBlock: to }).where(eq(invoices.id, row.id));
    }
    return none;
  }

  private async enqueueIpn(row: InvoiceRow): Promise<void> {
    const eventId = randomUUID();
    await this.deps.repos.insertWebhookEvent({
      clientId: row.clientId,
      invoiceId: row.id,
      targetUrl: row.ipnUrl,
      storeKeyId: row.storeKeyId,
      eventType: `invoice.${row.status}`,
      dedupeKey: `invoice:${row.id}:${row.status}`,
      payload: {
        event: `invoice.${row.status}`,
        event_id: eventId,
        created_at: this.now().toISOString(),
        data: this.dto(row),
      },
    });
  }

  /** Job do worker: sincroniza as faturas em aberto (mais antigas primeiro). */
  async runSyncCycle(limit = 100): Promise<{ checked: number; changed: number }> {
    const open = await this.deps.db
      .select()
      .from(invoices)
      .where(
        or(
          inArray(invoices.status, ['confirmando']),
          and(
            eq(invoices.status, 'aguardando'),
            or(
              lt(invoices.expiresAt, this.now()),
              sql`${invoices.pixChargeId} is not null`,
              sql`${invoices.swapOrderId} is not null`,
              sql`${invoices.usdcAmountMinor} is not null`,
              sql`${invoices.pixDiretoTxid} is not null`,
            ),
          ),
          // Pagamento atrasado: quem mandou USDC ou pagou o Pix do banco depois
          // do vencimento ainda vira `pago` (o dinheiro ja esta com a loja).
          and(
            eq(invoices.status, 'expirado'),
            sql`(${invoices.usdcAmountMinor} is not null or ${invoices.pixDiretoTxid} is not null)`,
            sql`${invoices.expiresAt} > ${new Date(this.now().getTime() - 86_400_000).toISOString()}::timestamptz`,
          ),
        ),
      )
      .orderBy(invoices.updatedAt)
      .limit(limit);
    let changed = 0;
    for (const row of open) {
      try {
        const next = await this.sync(row);
        if (next.status !== row.status) changed += 1;
      } catch (err) {
        this.deps.logger.warn({ err, invoiceId: row.id }, 'falha ao sincronizar fatura');
      }
    }
    return { checked: open.length, changed };
  }

  // ------------------------------------------------------- pagina publica

  private assertOpen(row: InvoiceRow, rail: InvoiceRail): void {
    if (row.status !== 'aguardando') throw new ConflictError('esta fatura nao aceita mais pagamento');
    if (!row.rails.includes(rail)) throw new ValidationError('meio de pagamento indisponivel nesta fatura');
  }

  /** Pagador escolheu Pix: cria a cobranca (uma so por fatura) com o CPF dele. */
  async choosePix(id: string, payerTaxNumber: string) {
    let row = await this.findPublic(id);
    if (!row) throw new NotFoundError('fatura nao encontrada');
    row = await this.sync(row);
    this.assertOpen(row, 'pix');
    const tax = normalizePayerTax(payerTaxNumber);
    if (row.mode === 'test') {
      await this.deps.db.update(invoices).set({ testRail: 'pix', updatedAt: this.now() }).where(eq(invoices.id, row.id));
      return this.paymentFor({ ...row, testRail: 'pix' }, 'pix');
    }
    if (!this.deps.pixCharges) throw new ValidationError('Pix indisponivel no momento');
    const { dto } = await this.deps.pixCharges.create({
      clientId: row.clientId,
      externalId: `inv_${row.id}`,
      amountBrlCents: row.amountCents,
      payerTaxNumber: tax,
      metadata: { invoice_id: row.id, order_id: row.orderId },
    });
    await this.deps.db.update(invoices).set({ pixChargeId: dto.id, updatedAt: this.now() }).where(eq(invoices.id, row.id));
    return this.paymentFor({ ...row, pixChargeId: dto.id }, 'pix');
  }

  /** Pagador escolheu Bitcoin: abre o swap (um so por fatura). */
  async chooseBitcoin(id: string) {
    let row = await this.findPublic(id);
    if (!row) throw new NotFoundError('fatura nao encontrada');
    row = await this.sync(row);
    this.assertOpen(row, 'bitcoin');
    if (row.mode === 'test') {
      await this.deps.db.update(invoices).set({ testRail: 'bitcoin', updatedAt: this.now() }).where(eq(invoices.id, row.id));
      return this.paymentFor({ ...row, testRail: 'bitcoin' }, 'bitcoin');
    }
    if (!this.deps.swap) throw new ValidationError('Bitcoin indisponivel no momento');
    const { dto } = await this.deps.swap.create({
      clientId: row.clientId,
      externalId: `inv_${row.id}:btc`,
      amountFiatCents: row.amountCents,
      currency: row.currency,
      ...(row.description ? { description: row.description } : {}),
      metadata: { invoice_id: row.id, order_id: row.orderId },
    });
    await this.deps.db.update(invoices).set({ swapOrderId: dto.id, updatedAt: this.now() }).where(eq(invoices.id, row.id));
    return this.paymentFor({ ...row, swapOrderId: dto.id }, 'bitcoin');
  }

  /**
   * O que o pagador precisa para pagar o trilho escolhido (QR, copia e cola,
   * endereco). Quem tem o link da fatura ja pode pagar: nao ha segredo aqui.
   */
  async paymentFor(row: InvoiceRow, rail: InvoiceRail): Promise<PublicPayment | null> {
    const qr = (text: string) => QRCode.toString(text, { type: 'svg', margin: 1, width: 240 });
    if (rail === 'usdc') {
      if (row.usdcAmountMinor === null || !row.usdcAddress) return null;
      if (row.mode === 'test' && row.testRail !== 'usdc') return null;
      const token = this.deps.config.settlement.usdcAddresses[0] ?? '';
      const amount = formatUsdc(row.usdcAmountMinor);
      // EIP-681: carteiras como a MetaMask abrem a transferencia pronta.
      const uri = `ethereum:${token}@${this.deps.config.settlement.chainId}/transfer?address=${row.usdcAddress}&uint256=${row.usdcAmountMinor}`;
      return {
        rail,
        address: getAddress(row.usdcAddress),
        amount_usdc: amount,
        network: this.deps.config.settlement.chain === 'polygon' ? 'Polygon' : 'Base',
        token,
        uri,
        qr_svg: await qr(uri),
        test: row.mode === 'test',
      };
    }
    if (row.mode === 'test') {
      if (row.testRail !== rail) return null;
      if (rail === 'pix' || rail === 'pix_direto') {
        const copy = `TESTE-SEM-VALOR-${row.id.slice(0, 8)}`;
        return { rail, qr_copypaste: copy, qr_svg: await qr(copy), test: true };
      }
      const address = 'tb1qteste0000000000000000000000000000000';
      const bip21 = `bitcoin:${address}?amount=0.0001`;
      return { rail: 'bitcoin', address, amount_btc: '0.0001', bip21, qr_svg: await qr(bip21), test: true };
    }
    if (rail === 'pix_direto' && row.pixDiretoCopypaste) {
      return { rail, qr_copypaste: row.pixDiretoCopypaste, qr_svg: await qr(row.pixDiretoCopypaste), test: false };
    }
    if (rail === 'pix' && row.pixChargeId) {
      const charge = await this.deps.repos.findPixChargeById(row.pixChargeId);
      if (!charge?.qrCopypaste) return null;
      return { rail, qr_copypaste: charge.qrCopypaste, qr_svg: await qr(charge.qrCopypaste), test: false };
    }
    if (rail === 'bitcoin' && row.swapOrderId) {
      const order = await this.deps.repos.findSwapOrderById(row.swapOrderId);
      if (!order?.depositAddress) return null;
      const btc = (Number(order.amountSats) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
      const bip21 = `bitcoin:${order.depositAddress}?amount=${btc}`;
      return { rail, address: order.depositAddress, amount_btc: btc, bip21, qr_svg: await qr(bip21), test: false };
    }
    return null;
  }

  /**
   * Pagador escolheu USDC: fixa o valor (com os "centavos de centavo"
   * unicos), o endereco da loja e o bloco de partida da busca.
   */
  async chooseUsdc(id: string) {
    let row = await this.findPublic(id);
    if (!row) throw new NotFoundError('fatura nao encontrada');
    row = await this.sync(row);
    this.assertOpen(row, 'usdc');
    if (row.usdcAmountMinor !== null && (row.mode === 'live' || row.testRail === 'usdc')) return this.paymentFor(row, 'usdc');

    let prices: { brl: bigint; usd: bigint } | undefined;
    if (row.currency === 'BRL') {
      if (this.deps.prices) {
        const [brl, usd] = await Promise.all([this.deps.prices.getBtcPrice('BRL'), this.deps.prices.getBtcPrice('USD')]);
        prices = { brl: brl.btcPriceCents, usd: usd.btcPriceCents };
      } else if (row.mode === 'test') {
        prices = { brl: 500n, usd: 100n }; // teste sem cotacao: 5 reais por dolar
      }
    }
    const base = usdcMinorFor(row.amountCents, row.currency, prices);

    let address: string;
    let startBlock: bigint;
    if (row.mode === 'test') {
      address = '0x000000000000000000000000000000000000dEaD';
      startBlock = 0n;
    } else {
      const wallet = await this.deps.repos.findActiveUsdcSettlementWalletForClient(row.clientId);
      const client = wallet ? null : await this.deps.repos.findClientById(row.clientId);
      const found = wallet?.address ?? client?.settlementAddress ?? null;
      if (!found) throw new ValidationError('a loja ainda nao tem carteira de recebimento');
      address = found.toLowerCase();
      startBlock = await this.chain().getBlockNumber();
    }

    // Valor unico entre as faturas em aberto para o mesmo endereco.
    let amount = base;
    for (let attempt = 0; attempt < 20; attempt++) {
      const dust = BigInt(1 + Math.floor(Math.random() * 9_999));
      const candidate = base + dust;
      const clash = await this.deps.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.usdcAddress, address),
            eq(invoices.usdcAmountMinor, candidate),
            inArray(invoices.status, ['aguardando', 'confirmando', 'expirado']),
          ),
        )
        .limit(1);
      if (clash.length === 0) {
        amount = candidate;
        break;
      }
    }
    if (amount === base) throw new ConflictError('nao foi possivel reservar um valor unico; tente de novo');

    const updated = await this.deps.db
      .update(invoices)
      .set({
        usdcAmountMinor: amount,
        usdcAddress: address,
        usdcStartBlock: startBlock,
        ...(row.mode === 'test' ? { testRail: 'usdc' as const } : {}),
        updatedAt: this.now(),
      })
      .where(and(eq(invoices.id, row.id), isNull(invoices.usdcAmountMinor)))
      .returning();
    const fresh = updated[0] ?? (await this.findPublic(row.id))!;
    return this.paymentFor(fresh, 'usdc');
  }

  /**
   * Pagador escolheu Pix e a loja ligou o banco dela: cria a cobranca na API
   * Pix do banco (o dinheiro cai em reais na conta da loja). Sem CPF: o
   * banco identifica o pagador.
   */
  async choosePixDireto(id: string) {
    let row = await this.findPublic(id);
    if (!row) throw new NotFoundError('fatura nao encontrada');
    row = await this.sync(row);
    this.assertOpen(row, 'pix_direto');
    if (row.mode === 'test') {
      await this.deps.db.update(invoices).set({ testRail: 'pix_direto', updatedAt: this.now() }).where(eq(invoices.id, row.id));
      return this.paymentFor({ ...row, testRail: 'pix_direto' }, 'pix_direto');
    }
    if (row.pixDiretoCopypaste) return this.paymentFor(row, 'pix_direto');
    if (!this.deps.pixDireto) throw new ValidationError('Pix indisponivel no momento');
    // txid da API Pix: 26 a 35 caracteres alfanumericos. O id da fatura sem
    // hifens tem 32 e torna a criacao idempotente no banco.
    const txid = row.id.replace(/-/g, '');
    const seconds = Math.max(300, Math.floor((row.expiresAt.getTime() - this.now().getTime()) / 1000));
    const charge = await this.deps.pixDireto.createCharge({
      clientId: row.clientId,
      txid,
      amountCents: row.amountCents,
      description: row.description ?? `Pedido ${row.orderId}`,
      expiresInSeconds: seconds,
    });
    const updated = await this.deps.db
      .update(invoices)
      .set({ pixDiretoTxid: txid, pixDiretoCopypaste: charge.copypaste, updatedAt: this.now() })
      .where(eq(invoices.id, row.id))
      .returning();
    return this.paymentFor(updated[0] ?? row, 'pix_direto');
  }

  /**
   * Cancela a fatura que ainda nao foi paga (ex.: a plataforma desistiu da
   * tentativa). Idempotente; fatura paga ou em confirmacao nao muda.
   */
  async cancel(id: string): Promise<InvoiceRow | null> {
    const row = await this.findPublic(id);
    if (!row) return null;
    if (row.status !== 'aguardando' && row.status !== 'expirado') return row;
    return this.transition(row, 'cancelado', null, row.txHash);
  }

  /** So no modo teste: marca como paga e dispara o IPN de verdade. */
  async simulatePayment(id: string) {
    const row = await this.findPublic(id);
    if (!row) throw new NotFoundError('fatura nao encontrada');
    if (row.mode !== 'test') throw new NotFoundError('fatura nao encontrada');
    if (row.status !== 'aguardando') throw new ConflictError('esta fatura nao aceita mais pagamento');
    return this.transition(row, 'pago', row.testRail ?? row.rails[0] ?? 'pix', null);
  }

  /** Estado para a pagina publica: sem dado interno da loja alem do nome. */
  async publicState(id: string) {
    const found = await this.findPublic(id);
    if (!found) throw new NotFoundError('fatura nao encontrada');
    const row = await this.sync(found);
    const client = await this.deps.repos.findClientById(row.clientId);
    return {
      id: row.id,
      merchant_name: client?.name ?? '',
      status: row.status,
      mode: row.mode,
      price_amount: centsToDecimal(row.amountCents),
      price_currency: row.currency,
      description: row.description,
      rails: row.rails,
      payments: (
        await Promise.all(row.rails.map((rail) => (row.status === 'aguardando' ? this.paymentFor(row, rail) : null)))
      ).filter((p): p is PublicPayment => p !== null),
      expires_at: row.expiresAt.toISOString(),
      // Redireciona so depois do fim: a URL vem da loja, nao do pagador.
      success_url: row.status === 'pago' ? row.successUrl : null,
      cancel_url: row.status === 'expirado' || row.status === 'cancelado' ? row.cancelUrl : null,
    };
  }

  /** Lista do painel (cursor por created_at/id). */
  async listForClient(clientId: string, opts: { limit: number; mode?: StoreKeyMode | undefined }) {
    return this.deps.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.clientId, clientId), opts.mode ? eq(invoices.mode, opts.mode) : undefined))
      .orderBy(desc(invoices.createdAt))
      .limit(opts.limit);
  }
}
