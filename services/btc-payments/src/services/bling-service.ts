import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto/cipher.js';
import type { Db } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { blingConnections, blingExports, invoices } from '../db/schema.js';
import { NotFoundError, UnauthorizedError, UpstreamError, ValidationError } from '../domain/errors.js';
import type { Logger } from '../logger.js';

/**
 * Bling (ERP): cada fatura paga vira uma conta a receber no Bling da loja,
 * no contato "Consumidor Final" (nao copiamos dado pessoal do pagador). Se a
 * loja escolheu conta financeira e categoria de receita, a conta ja entra
 * com baixa (recebida).
 *
 * Contrato tirado da especificacao OpenAPI oficial do Bling (API v3).
 */

export const BLING_API = 'https://api.bling.com.br/Api/v3';
export const BLING_AUTHORIZE = 'https://bling.com.br/Api/v3/oauth/authorize';
export const BLING_TOKEN = 'https://bling.com.br/Api/v3/oauth/token';

export type BlingFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export type BlingDeps = {
  db: Db;
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  fetchImpl?: BlingFetch;
  /** Pausa entre chamadas (o Bling aceita 3 por segundo por conta). */
  pauseMs?: number;
  now?: () => Date;
};

const STATE_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

type Connection = typeof blingConnections.$inferSelect;

function centsToNumber(cents: bigint): number {
  return Number(cents) / 100;
}

/** Data no fuso de Sao Paulo, como o Bling espera ("2026-11-08"). */
export function blingDate(date: Date): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

export class BlingService {
  private readonly now: () => Date;
  private readonly fetchImpl: BlingFetch;

  constructor(private readonly deps: BlingDeps) {
    this.now = deps.now ?? (() => new Date());
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as BlingFetch);
  }

  get enabled(): boolean {
    return this.deps.config.bling !== null;
  }

  private get app() {
    const app = this.deps.config.bling;
    if (!app) throw new NotFoundError('integracao Bling desligada');
    return app;
  }

  private sleep(): Promise<void> {
    const ms = this.deps.pauseMs ?? 400;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  private seal(value: string, clientId: string): string {
    const kid = this.deps.config.crypto.activeKid;
    const key = this.deps.config.crypto.keyring[kid];
    if (!key) throw new Error('chave ativa de cifragem ausente');
    return encryptSecret(value, key, kid, `bling:${clientId}`);
  }

  private open(value: string, clientId: string): string {
    return decryptSecret(value, this.deps.config.crypto.keyring, `bling:${clientId}`);
  }

  // ---------------------------------------------------------------- OAuth

  authorizeUrl(clientId: string): string {
    const payload = Buffer.from(JSON.stringify({ c: clientId, e: this.now().getTime() + STATE_TTL_MS, n: randomUUID() })).toString('base64url');
    const mac = createHmac('sha256', this.app.clientSecret).update(payload).digest('base64url');
    const params = new URLSearchParams({ response_type: 'code', client_id: this.app.clientId, state: `${payload}.${mac}` });
    return `${BLING_AUTHORIZE}?${params}`;
  }

  private verifyState(state: string): string {
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

  private async tokenRequest(form: Record<string, string>) {
    const basic = Buffer.from(`${this.app.clientId}:${this.app.clientSecret}`).toString('base64');
    let response;
    try {
      response = await this.fetchImpl(BLING_TOKEN, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
      });
    } catch (err) {
      throw new UpstreamError('Bling indisponivel', { cause: err });
    }
    const data = (await response.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
    if (response.status !== 200 || !data?.access_token || !data.refresh_token) {
      throw new UpstreamError('o Bling recusou a autorizacao; conecte de novo');
    }
    return { access: data.access_token, refresh: data.refresh_token, expiresAt: new Date(this.now().getTime() + (data.expires_in ?? 21_600) * 1000) };
  }

  async completeInstall(code: string, state: string): Promise<string> {
    const clientId = this.verifyState(state);
    const token = await this.tokenRequest({ grant_type: 'authorization_code', code });
    const values = {
      accessTokenEnc: this.seal(token.access, clientId),
      refreshTokenEnc: this.seal(token.refresh, clientId),
      expiresAt: token.expiresAt,
      connectedAt: this.now(),
      lastError: null,
      consumidorFinalId: null,
    };
    await this.deps.db
      .insert(blingConnections)
      .values({ clientId, ...values })
      .onConflictDoUpdate({ target: blingConnections.clientId, set: values });
    await this.deps.repos.insertAuditEvent({ actor: 'bling', action: 'bling.connected', entity: 'api_client', entityId: clientId });
    return clientId;
  }

  private async connection(clientId: string): Promise<Connection | null> {
    const rows = await this.deps.db.select().from(blingConnections).where(eq(blingConnections.clientId, clientId)).limit(1);
    return rows[0] ?? null;
  }

  /** Token valido; renova quando faltar menos de 2 minutos (o refresh pode rodar). */
  private async accessToken(conn: Connection): Promise<string> {
    if (conn.expiresAt.getTime() - this.now().getTime() > 120_000) return this.open(conn.accessTokenEnc, conn.clientId);
    const token = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.open(conn.refreshTokenEnc, conn.clientId) });
    // O refresh token muda a cada renovacao: grava os dois e atualiza a
    // conexao em memoria (as proximas chamadas do mesmo ciclo usam o novo).
    conn.accessTokenEnc = this.seal(token.access, conn.clientId);
    conn.refreshTokenEnc = this.seal(token.refresh, conn.clientId);
    conn.expiresAt = token.expiresAt;
    await this.deps.db
      .update(blingConnections)
      .set({ accessTokenEnc: conn.accessTokenEnc, refreshTokenEnc: conn.refreshTokenEnc, expiresAt: conn.expiresAt })
      .where(eq(blingConnections.clientId, conn.clientId));
    return token.access;
  }

  private async api(conn: Connection, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const token = await this.accessToken(conn);
    let response;
    try {
      response = await this.fetchImpl(`${BLING_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new UpstreamError('Bling indisponivel', { cause: err });
    }
    await this.sleep();
    return { status: response.status, data: await response.json().catch(() => null) };
  }

  private blingError(what: string, status: number, data: unknown): UpstreamError {
    const err = (data as { error?: { description?: string; message?: string; fields?: { msg?: string }[] } } | null)?.error;
    const detail = err?.fields?.[0]?.msg ?? err?.description ?? err?.message;
    return new UpstreamError(`Bling recusou ${what} (${status}${detail ? `: ${detail}` : ''})`);
  }

  // ------------------------------------------------------------- painel

  async status(clientId: string) {
    const conn = await this.connection(clientId);
    if (!conn) return { available: this.enabled, connected: false as const };
    const pending = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(blingExports)
      .where(and(eq(blingExports.clientId, clientId), sql`${blingExports.contaId} is null`));
    return {
      available: this.enabled,
      connected: true as const,
      connected_at: conn.connectedAt.toISOString(),
      portador_id: conn.portadorId?.toString() ?? null,
      categoria_id: conn.categoriaId?.toString() ?? null,
      last_error: conn.lastError,
      pending_with_error: pending[0]?.n ?? 0,
    };
  }

  /** Contas financeiras e categorias de receita ativas, para a loja escolher. */
  async options(clientId: string) {
    const conn = await this.connection(clientId);
    if (!conn) throw new NotFoundError('Bling nao conectado');
    const contas = await this.api(conn, 'GET', '/contas-contabeis?situacoes[]=1');
    const categorias = await this.api(conn, 'GET', '/categorias/receitas-despesas?tipo=2&situacao=1');
    const list = (r: { status: number; data: unknown }) =>
      r.status === 200 ? ((r.data as { data?: { id: number; descricao: string }[] }).data ?? []).map((x) => ({ id: String(x.id), descricao: x.descricao })) : [];
    return { portadores: list(contas), categorias: list(categorias) };
  }

  async setSettings(clientId: string, input: { portadorId: string | null; categoriaId: string | null }) {
    const conn = await this.connection(clientId);
    if (!conn) throw new NotFoundError('Bling nao conectado');
    const parse = (v: string | null) => {
      if (v === null || v === '') return null;
      if (!/^\d{1,18}$/.test(v)) throw new ValidationError('id invalido');
      return BigInt(v);
    };
    await this.deps.db
      .update(blingConnections)
      .set({ portadorId: parse(input.portadorId), categoriaId: parse(input.categoriaId) })
      .where(eq(blingConnections.clientId, clientId));
    return this.status(clientId);
  }

  async disconnect(clientId: string) {
    await this.deps.db.delete(blingConnections).where(eq(blingConnections.clientId, clientId));
    await this.deps.repos.insertAuditEvent({ actor: 'painel', action: 'bling.disconnected', entity: 'api_client', entityId: clientId });
  }

  // --------------------------------------------------------- lancamentos

  private async consumidorFinal(conn: Connection): Promise<bigint> {
    if (conn.consumidorFinalId) return conn.consumidorFinalId;
    const { status, data } = await this.api(conn, 'GET', '/contatos/consumidor-final');
    const id = (data as { data?: { id?: number } } | null)?.data?.id;
    if (status !== 200 || !id) throw this.blingError('o contato Consumidor Final', status, data);
    await this.deps.db.update(blingConnections).set({ consumidorFinalId: BigInt(id) }).where(eq(blingConnections.clientId, conn.clientId));
    conn.consumidorFinalId = BigInt(id);
    return conn.consumidorFinalId;
  }

  /**
   * Job do worker: faturas de producao pagas em real, de lojas com Bling
   * conectado, ainda nao lancadas (ou com erro, ate 5 tentativas).
   */
  async runExportCycle(limit = 20): Promise<{ checked: number; exported: number }> {
    const rows = await this.deps.db
      .select({ invoice: invoices, conn: blingConnections, exp: blingExports })
      .from(invoices)
      .innerJoin(blingConnections, eq(blingConnections.clientId, invoices.clientId))
      .leftJoin(blingExports, eq(blingExports.invoiceId, invoices.id))
      .where(
        and(
          eq(invoices.status, 'pago'),
          eq(invoices.mode, 'live'),
          eq(invoices.currency, 'BRL'),
          // So o que foi pago depois de conectar: o passado fica no CSV.
          sql`${invoices.paidAt} >= ${blingConnections.connectedAt}`,
          or(isNull(blingExports.invoiceId), and(isNull(blingExports.contaId), lt(blingExports.attempts, MAX_ATTEMPTS))),
        ),
      )
      .limit(limit);
    let exported = 0;
    // Uma conexao por loja no ciclo: renovar o token muda o refresh token, e
    // uma copia antiga tentaria renovar com o refresh ja trocado.
    const connections = new Map<string, Connection>();
    for (const { invoice, conn: row } of rows) {
      const conn = connections.get(row.clientId) ?? row;
      connections.set(row.clientId, conn);
      try {
        await this.exportOne(conn, invoice);
        exported += 1;
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        await this.deps.db
          .insert(blingExports)
          .values({ invoiceId: invoice.id, clientId: invoice.clientId, attempts: 1, error: message })
          .onConflictDoUpdate({ target: blingExports.invoiceId, set: { attempts: sql`${blingExports.attempts} + 1`, error: message } });
        await this.deps.db.update(blingConnections).set({ lastError: message }).where(eq(blingConnections.clientId, conn.clientId));
        this.deps.logger.warn({ err, invoiceId: invoice.id }, 'falha ao lancar venda no Bling');
      }
    }
    return { checked: rows.length, exported };
  }

  private async exportOne(conn: Connection, invoice: typeof invoices.$inferSelect): Promise<void> {
    const contato = await this.consumidorFinal(conn);
    const paidDay = blingDate(invoice.paidAt ?? this.now());
    const valor = centsToNumber(invoice.amountCents);
    const meio = { pix: 'Pix (dólar digital)', pix_direto: 'Pix', bitcoin: 'Bitcoin', usdc: 'USDC' }[invoice.paidRail ?? 'pix'] ?? 'LibreFlow';
    const historico = `LibreFlow Pay · ${meio} · pedido ${invoice.orderId}${invoice.txHash ? ` · ${invoice.txHash}` : ''}`.slice(0, 250);
    const created = await this.api(conn, 'POST', '/contas/receber', {
      vencimento: paidDay,
      valor,
      contato: { id: Number(contato) },
      dataEmissao: paidDay,
      competencia: paidDay,
      numeroDocumento: invoice.orderId.slice(0, 30),
      historico,
      ...(conn.categoriaId ? { categoria: { id: Number(conn.categoriaId) } } : {}),
      ...(conn.portadorId ? { portador: { id: Number(conn.portadorId) } } : {}),
    });
    const contaId = (created.data as { data?: { id?: number } } | null)?.data?.id;
    if (created.status !== 201 && created.status !== 200) throw this.blingError('a conta a receber', created.status, created.data);
    if (!contaId) throw this.blingError('a conta a receber', created.status, created.data);

    let settled = false;
    if (conn.portadorId && conn.categoriaId) {
      const baixa = await this.api(conn, 'POST', `/contas/receber/${contaId}/baixar`, {
        data: paidDay,
        usarDataVencimento: false,
        portador: { id: Number(conn.portadorId) },
        categoria: { id: Number(conn.categoriaId) },
        historico,
        valorRecebido: valor,
      });
      // A conta ja existe: falha na baixa nao duplica o lancamento.
      settled = baixa.status === 200 || baixa.status === 201 || baixa.status === 204;
      if (!settled) this.deps.logger.warn({ status: baixa.status, contaId }, 'Bling: conta criada, baixa recusada');
    }
    await this.deps.db
      .insert(blingExports)
      .values({ invoiceId: invoice.id, clientId: invoice.clientId, contaId: BigInt(contaId), settled, attempts: 1, exportedAt: this.now() })
      .onConflictDoUpdate({
        target: blingExports.invoiceId,
        set: { contaId: BigInt(contaId), settled, error: null, exportedAt: this.now(), attempts: sql`${blingExports.attempts} + 1` },
      });
    await this.deps.db.update(blingConnections).set({ lastError: null }).where(eq(blingConnections.clientId, conn.clientId));
  }
}
