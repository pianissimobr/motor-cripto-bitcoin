import { createHash, createHmac, createVerify, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, gte, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto/cipher.js';
import type { Db } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { invoices, nuvemshopPayments, nuvemshopStores } from '../db/schema.js';
import { NotFoundError, UnauthorizedError, UpstreamError, ValidationError } from '../domain/errors.js';
import type { Logger } from '../logger.js';
import type { InvoiceService } from './invoice-service.js';

/**
 * App de pagamento da Nuvemshop.
 *
 * Instalacao: OAuth -> registra o provedor de pagamento (checkout_js_url) e
 * os webhooks. Pagamento: o checkout chama o process_payment (assinado pela
 * Nuvemshop), o motor cria a fatura e devolve o redirect_url. O
 * process_payment nao traz o numero do pedido: ele e achado pelo webhook
 * order/created (loja, e-mail e valor numa janela de tempo), e quando a
 * fatura muda o motor cria/atualiza a transacao no pedido.
 *
 * Pontos a confirmar na homologacao com a Nuvemshop: o formato exato do
 * X-Signature e da tabela de taxas, e o casamento pedido <-> tentativa.
 */

export type NuvemshopFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export type NuvemshopDeps = {
  db: Db;
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  invoices: InvoiceService;
  fetchImpl?: NuvemshopFetch;
  now?: () => Date;
};

export const PAYMENT_OPTION_ID = 'libreflow_redirect';
const STATE_TTL_MS = 15 * 60_000;

type Process = {
  storeId: string;
  cartId: string;
  attemptId: string;
  totalCents: bigint;
  currency: string;
  email: string | null;
  successUrl: string | null;
  cancelUrl: string | null;
};

/** "149.70" ou 149.7 -> 14970n. */
export function nuvemshopAmountToCents(value: unknown): bigint {
  const text = typeof value === 'number' ? value.toFixed(2) : String(value ?? '');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) throw new ValidationError('valor do carrinho invalido');
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

function centsToDecimal(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export class NuvemshopService {
  private readonly now: () => Date;
  private readonly fetchImpl: NuvemshopFetch;

  constructor(private readonly deps: NuvemshopDeps) {
    this.now = deps.now ?? (() => new Date());
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as NuvemshopFetch);
  }

  private get app() {
    const app = this.deps.config.nuvemshop;
    if (!app) throw new NotFoundError('integracao Nuvemshop desligada');
    return app;
  }

  get enabled(): boolean {
    return this.deps.config.nuvemshop !== null;
  }

  private base(): string {
    return this.deps.config.service.publicBaseUrl.replace(/\/+$/, '');
  }

  // -------------------------------------------------------------- estado

  /** state do OAuth: loja do motor + validade, assinado (HMAC do segredo do app). */
  signState(clientId: string): string {
    const payload = Buffer.from(JSON.stringify({ c: clientId, e: this.now().getTime() + STATE_TTL_MS, n: randomUUID() })).toString('base64url');
    const mac = createHmac('sha256', this.app.clientSecret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  verifyState(state: string): string {
    const [payload, mac] = state.split('.');
    if (!payload || !mac) throw new UnauthorizedError('state invalido');
    const expected = createHmac('sha256', this.app.clientSecret).update(payload).digest('base64url');
    if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) {
      throw new UnauthorizedError('state invalido');
    }
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { c: string; e: number };
    if (data.e < this.now().getTime()) throw new UnauthorizedError('autorizacao expirada; conecte de novo');
    return data.c;
  }

  authorizeUrl(clientId: string): string {
    return `https://www.nuvemshop.com.br/apps/${encodeURIComponent(this.app.appId)}/authorize?state=${encodeURIComponent(this.signState(clientId))}`;
  }

  // ---------------------------------------------------------------- API

  private seal(value: string, aad: string): string {
    const kid = this.deps.config.crypto.activeKid;
    const key = this.deps.config.crypto.keyring[kid];
    if (!key) throw new Error('chave ativa de cifragem ausente');
    return encryptSecret(value, key, kid, `nuvemshop:${aad}`);
  }

  private async store(storeId: string) {
    const rows = await this.deps.db.select().from(nuvemshopStores).where(eq(nuvemshopStores.storeId, storeId)).limit(1);
    const row = rows[0];
    if (!row || row.uninstalledAt) return null;
    return row;
  }

  private async api(storeId: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const row = await this.store(storeId);
    if (!row) throw new NotFoundError('loja Nuvemshop nao conectada');
    const token = decryptSecret(row.accessTokenEnc, this.deps.config.crypto.keyring, `nuvemshop:${storeId}`);
    let response;
    try {
      response = await this.fetchImpl(`${this.app.apiBase}/${encodeURIComponent(storeId)}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': `LibreFlow Pay (${this.base()})`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new UpstreamError('Nuvemshop indisponivel', { cause: err });
    }
    return { status: response.status, data: await response.json().catch(() => null) };
  }

  // ---------------------------------------------------------- instalacao

  /**
   * Volta do OAuth: troca o code pelo token, guarda cifrado, registra o
   * provedor de pagamento e os webhooks.
   */
  async completeInstall(code: string, state: string): Promise<{ clientId: string; storeId: string }> {
    const clientId = this.verifyState(state);
    let response;
    try {
      response = await this.fetchImpl('https://www.tiendanube.com/apps/authorize/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: this.app.clientId,
          client_secret: this.app.clientSecret,
          grant_type: 'authorization_code',
          code,
        }),
      });
    } catch (err) {
      throw new UpstreamError('Nuvemshop indisponivel', { cause: err });
    }
    const data = (await response.json().catch(() => null)) as { access_token?: string; scope?: string; user_id?: string | number; store_id?: string | number } | null;
    const storeId = String(data?.user_id ?? data?.store_id ?? '');
    if (response.status !== 200 || !data?.access_token || !/^\d+$/.test(storeId)) {
      throw new UpstreamError('a Nuvemshop recusou a autorizacao; tente conectar de novo');
    }
    const values = {
      clientId,
      accessTokenEnc: this.seal(data.access_token, storeId),
      scope: data.scope ?? null,
      installedAt: this.now(),
      uninstalledAt: null,
    };
    await this.deps.db
      .insert(nuvemshopStores)
      .values({ storeId, ...values })
      .onConflictDoUpdate({ target: nuvemshopStores.storeId, set: values });

    const providerId = await this.registerProvider(storeId);
    await this.deps.db.update(nuvemshopStores).set({ paymentProviderId: providerId }).where(eq(nuvemshopStores.storeId, storeId));
    await this.registerWebhooks(storeId);
    await this.deps.repos.insertAuditEvent({
      actor: 'nuvemshop',
      action: 'nuvemshop.installed',
      entity: 'api_client',
      entityId: clientId,
      metadata: { storeId },
    });
    return { clientId, storeId };
  }

  private async registerProvider(storeId: string): Promise<string> {
    const base = this.base();
    const payload = {
      name: 'LibreFlow Pay',
      public_name: 'Pix, Bitcoin ou USDC',
      description: 'Receba em Pix, Bitcoin e USDC; liquidado em dólar digital (ou Pix em reais na sua conta).',
      logo_urls: { '400x120': `${base}/nuvemshop/logo-400x120.png`, '160x100': `${base}/nuvemshop/logo-160x100.png` },
      configuration_url: `${base}/painel/integracao`,
      support_url: `${base}/painel/integracao`,
      rates_url: `${base}/painel/integracao`,
      checkout_js_url: `${base}/integrations/nuvemshop/checkout.js`,
      supported_currencies: ['BRL', 'USD'],
      supported_payment_methods: [
        { payment_method_type: 'pix', payment_methods: ['pix'] },
        { payment_method_type: 'wallet', payment_methods: ['libreflow'] },
      ],
      checkout_payment_options: [
        {
          id: PAYMENT_OPTION_ID,
          name: 'Pix, Bitcoin ou USDC',
          description: 'Você será levado a uma página segura para pagar.',
          supported_billing_countries: ['BR'],
          supported_payment_method_types: ['pix', 'wallet'],
          integration_type: 'redirect',
        },
      ],
      enabled: true,
    };
    const existing = await this.store(storeId);
    if (existing?.paymentProviderId) {
      const { status } = await this.api(storeId, 'PUT', `/payment/providers/${existing.paymentProviderId}`, payload);
      if (status >= 200 && status < 300) return existing.paymentProviderId;
    }
    const { status, data } = await this.api(storeId, 'POST', '/payment_providers', payload);
    const id = (data as { id?: string } | null)?.id;
    if (status !== 201 || !id) {
      throw new UpstreamError(`a Nuvemshop recusou o cadastro do meio de pagamento (${status}); a conta de parceiro precisa ter a API de pagamentos liberada`);
    }
    return id;
  }

  private async registerWebhooks(storeId: string): Promise<void> {
    const url = `${this.base()}/integrations/nuvemshop/webhook`;
    for (const event of ['order/created', 'app/uninstalled', 'store/redact', 'customers/redact', 'customers/data_request']) {
      const { status } = await this.api(storeId, 'POST', '/webhooks', { event, url });
      if (status !== 201 && status !== 422) {
        this.deps.logger.warn({ storeId, event, status }, 'webhook Nuvemshop nao registrado');
      }
    }
  }

  async storesFor(clientId: string) {
    const rows = await this.deps.db.select().from(nuvemshopStores).where(eq(nuvemshopStores.clientId, clientId));
    return rows.map((r) => ({
      store_id: r.storeId,
      installed_at: r.installedAt.toISOString(),
      active: r.uninstalledAt === null,
      payment_provider: r.paymentProviderId !== null,
    }));
  }

  // ----------------------------------------------------------- assinaturas

  /**
   * X-Signature das chamadas da Nuvemshop: RSA-SHA256 sobre
   * "URL|timestamp|sha256(corpo)" (base64), com a chave publica deles.
   */
  verifyPlatformSignature(input: { url: string; timestamp: string | undefined; signature: string | undefined; rawBody: string }): boolean {
    const key = this.app.signingPublicKey;
    if (!key) return !this.deps.config.service.isProduction;
    if (!input.timestamp || !input.signature || !/^\d+$/.test(input.timestamp)) return false;
    const ts = Number(input.timestamp);
    const nowSec = Math.floor(this.now().getTime() / 1000);
    const skew = Math.abs((ts > 1e12 ? Math.floor(ts / 1000) : ts) - nowSec);
    if (skew > 300) return false;
    const digest = createHash('sha256').update(input.rawBody).digest('hex');
    try {
      return createVerify('RSA-SHA256').update(`${input.url}|${input.timestamp}|${digest}`).verify(key, input.signature, 'base64');
    } catch {
      return false;
    }
  }

  /** Webhook: x-linkedstore-hmac-sha256 = HMAC-SHA256 hex do corpo com o segredo do app. */
  verifyWebhook(rawBody: string, header: string | undefined): boolean {
    if (!header) return false;
    const expected = createHmac('sha256', this.app.clientSecret).update(rawBody).digest('hex');
    return expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  }

  // ------------------------------------------------------------ pagamento

  parseProcess(body: unknown): Process {
    const b = body as {
      store_id?: string | number;
      cartId?: string | number;
      prices?: { total?: unknown; currency?: string };
      payment?: { attemptId?: string };
      customer?: { email?: string };
      extra?: { success_url?: string; cancel_url?: string };
    };
    const storeId = String(b?.store_id ?? '');
    const cartId = String(b?.cartId ?? '');
    const attemptId = String(b?.payment?.attemptId ?? '');
    if (!/^\d+$/.test(storeId) || !cartId || !/^[\w-]{6,80}$/.test(attemptId)) throw new ValidationError('pagamento incompleto');
    const url = (value: unknown) => (typeof value === 'string' && /^https:\/\//.test(value) ? value : null);
    return {
      storeId,
      cartId,
      attemptId,
      totalCents: nuvemshopAmountToCents(b.prices?.total),
      currency: String(b.prices?.currency ?? 'BRL').toUpperCase(),
      email: typeof b.customer?.email === 'string' ? b.customer.email : null,
      successUrl: url(b.extra?.success_url),
      cancelUrl: url(b.extra?.cancel_url),
    };
  }

  /** process_payment: cria a fatura (uma por tentativa) e devolve o redirect. */
  async processPayment(input: Process): Promise<{ redirect_url: string; invoice_id: string }> {
    const store = await this.store(input.storeId);
    if (!store) throw new NotFoundError('loja nao conectada');
    const existing = await this.deps.db.select().from(nuvemshopPayments).where(eq(nuvemshopPayments.attemptId, input.attemptId)).limit(1);
    if (existing[0]) {
      const invoice = await this.deps.invoices.findPublic(existing[0].invoiceId);
      return { redirect_url: this.deps.invoices.dto(invoice!).invoice_url, invoice_id: existing[0].invoiceId };
    }
    if (input.currency !== 'BRL' && input.currency !== 'USD') throw new ValidationError('moeda nao suportada');
    const client = await this.deps.repos.findClientById(store.clientId);
    if (!client || client.status !== 'ativo') throw new NotFoundError('loja indisponivel');
    const { invoice } = await this.deps.invoices.create(client, null, 'live', {
      priceAmount: centsToDecimal(input.totalCents),
      priceCurrency: input.currency,
      orderId: `ns-${input.storeId}-${input.attemptId}`.slice(0, 64),
      orderDescription: `Pedido na loja Nuvemshop`,
      ...(input.email ? { customerEmail: input.email } : {}),
      ...(input.successUrl ? { successUrl: input.successUrl } : {}),
      ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
    });
    await this.deps.db
      .insert(nuvemshopPayments)
      .values({
        attemptId: input.attemptId,
        storeId: input.storeId,
        invoiceId: invoice.id,
        cartId: input.cartId,
        email: input.email?.toLowerCase() ?? null,
        totalCents: input.totalCents,
        currency: input.currency,
      })
      .onConflictDoNothing();
    return { redirect_url: this.deps.invoices.dto(invoice).invoice_url, invoice_id: invoice.id };
  }

  /** cancel_payment: idempotente. */
  async cancelPayment(attemptId: string): Promise<void> {
    const rows = await this.deps.db.select().from(nuvemshopPayments).where(eq(nuvemshopPayments.attemptId, attemptId)).limit(1);
    if (rows[0]) await this.deps.invoices.cancel(rows[0].invoiceId);
  }

  // ---------------------------------------------------- pedido e transacao

  /**
   * order/created: busca o pedido e, se for deste meio de pagamento, liga
   * a tentativa de mesmo e-mail e valor, sem pedido ainda, criada nas
   * ultimas 2 horas (a mais recente).
   */
  async onOrderCreated(storeId: string, orderId: string): Promise<boolean> {
    const store = await this.store(storeId);
    if (!store) return false;
    const { status, data } = await this.api(storeId, 'GET', `/orders/${encodeURIComponent(orderId)}`);
    if (status !== 200) return false;
    const order = data as { id?: number | string; total?: unknown; currency?: string; contact_email?: string; customer?: { email?: string }; gateway?: string };
    if (store.paymentProviderId && order.gateway && order.gateway !== store.paymentProviderId && order.gateway !== PAYMENT_OPTION_ID) {
      return false;
    }
    const email = (order.contact_email ?? order.customer?.email ?? '').toLowerCase();
    const total = nuvemshopAmountToCents(order.total);
    const since = new Date(this.now().getTime() - 2 * 3_600_000);
    const candidates = await this.deps.db
      .select()
      .from(nuvemshopPayments)
      .where(
        and(
          eq(nuvemshopPayments.storeId, storeId),
          isNull(nuvemshopPayments.orderId),
          eq(nuvemshopPayments.totalCents, total),
          gte(nuvemshopPayments.createdAt, since),
          email ? eq(nuvemshopPayments.email, email) : sql`true`,
        ),
      )
      .orderBy(sql`${nuvemshopPayments.createdAt} desc`)
      .limit(1);
    const match = candidates[0];
    if (!match) return false;
    const linked = await this.deps.db
      .update(nuvemshopPayments)
      .set({ orderId: String(order.id ?? orderId), updatedAt: this.now() })
      .where(and(eq(nuvemshopPayments.attemptId, match.attemptId), isNull(nuvemshopPayments.orderId)))
      .returning();
    return linked.length > 0;
  }

  async onUninstalled(storeId: string): Promise<void> {
    await this.deps.db.update(nuvemshopStores).set({ uninstalledAt: this.now() }).where(eq(nuvemshopStores.storeId, storeId));
  }

  /**
   * Job do worker: para cada tentativa com pedido ligado cujo estado da
   * fatura ainda nao foi avisado, cria a transacao (pending) e, quando
   * paga, manda o evento de venda com sucesso.
   */
  async runSyncCycle(limit = 50): Promise<{ checked: number; reported: number }> {
    const rows = await this.deps.db
      .select({ payment: nuvemshopPayments, invoice: invoices, store: nuvemshopStores })
      .from(nuvemshopPayments)
      .innerJoin(invoices, eq(invoices.id, nuvemshopPayments.invoiceId))
      .innerJoin(nuvemshopStores, eq(nuvemshopStores.storeId, nuvemshopPayments.storeId))
      .where(
        and(
          sql`${nuvemshopPayments.orderId} is not null`,
          isNull(nuvemshopStores.uninstalledAt),
          or(isNull(nuvemshopPayments.reportedStatus), and(eq(invoices.status, 'pago'), ne(nuvemshopPayments.reportedStatus, 'success'))),
        ),
      )
      .limit(limit);
    let reported = 0;
    for (const { payment, invoice, store } of rows) {
      try {
        if (await this.report(payment, invoice, store)) reported += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.deps.db.update(nuvemshopPayments).set({ lastError: message.slice(0, 500), updatedAt: this.now() }).where(eq(nuvemshopPayments.attemptId, payment.attemptId));
        this.deps.logger.warn({ err, attemptId: payment.attemptId }, 'falha ao avisar a Nuvemshop');
      }
    }
    return { checked: rows.length, reported };
  }

  private async report(
    payment: typeof nuvemshopPayments.$inferSelect,
    invoice: typeof invoices.$inferSelect,
    store: typeof nuvemshopStores.$inferSelect,
  ): Promise<boolean> {
    const paid = invoice.status === 'pago';
    const happenedAt = (invoice.paidAt ?? this.now()).toISOString();
    const method = invoice.paidRail === 'pix' || invoice.paidRail === 'pix_direto' ? 'pix' : 'wallet';
    const authorization = invoice.txHash ?? invoice.id;
    if (!payment.transactionId) {
      const { status, data } = await this.api(payment.storeId, 'POST', `/orders/${payment.orderId}/transactions`, {
        payment_provider_id: store.paymentProviderId,
        payment_attempt_id: payment.attemptId,
        ...(this.app.providerTaxId ? { payment_provider_tax_id: this.app.providerTaxId } : {}),
        payment_method: { type: method },
        info: { external_id: invoice.id, external_url: this.deps.invoices.dto(invoice).invoice_url },
        first_event: {
          amount: { value: centsToDecimal(payment.totalCents), currency: payment.currency },
          type: 'sale',
          status: paid ? 'success' : 'pending',
          happened_at: happenedAt,
          ...(paid && method === 'pix' ? { authorization_code: authorization } : {}),
        },
      });
      const id = (data as { id?: string } | null)?.id;
      if (status !== 201 || !id) throw new UpstreamError(`transacao recusada pela Nuvemshop (${status})`);
      await this.deps.db
        .update(nuvemshopPayments)
        .set({ transactionId: id, reportedStatus: paid ? 'success' : 'pending', lastError: null, updatedAt: this.now() })
        .where(eq(nuvemshopPayments.attemptId, payment.attemptId));
      return true;
    }
    if (!paid) return false;
    const { status } = await this.api(payment.storeId, 'POST', `/orders/${payment.orderId}/transactions/${payment.transactionId}/events`, {
      type: 'sale',
      status: 'success',
      happened_at: happenedAt,
      ...(method === 'pix' ? { authorization_code: authorization } : {}),
    });
    if (status !== 201) throw new UpstreamError(`evento recusado pela Nuvemshop (${status})`);
    await this.deps.db
      .update(nuvemshopPayments)
      .set({ reportedStatus: 'success', lastError: null, updatedAt: this.now() })
      .where(eq(nuvemshopPayments.attemptId, payment.attemptId));
    return true;
  }
}
