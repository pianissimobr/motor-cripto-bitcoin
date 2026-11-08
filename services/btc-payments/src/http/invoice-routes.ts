import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFoundError, UnauthorizedError, ValidationError } from '../domain/errors.js';
import type { ApiClient } from '../domain/types.js';
import type { InvoiceService, StoreKeyRow } from '../services/invoice-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    storeKey?: StoreKeyRow;
    storeClient?: ApiClient;
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(`${what} invalido`, result.error.issues);
  return result.data;
}

const createSchema = z
  .object({
    price_amount: z.union([z.string().max(20), z.number().positive().max(1e12)]).transform((v) => String(v)),
    price_currency: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.enum(['BRL', 'USD'])),
    order_id: z.union([z.string().trim().min(1).max(64), z.number().int().nonnegative()]).transform((v) => String(v)),
    order_description: z.string().trim().max(200).optional(),
    customer_email: z.string().trim().email().max(254).optional(),
    success_url: z.string().trim().max(500).optional(),
    cancel_url: z.string().trim().max(500).optional(),
    ipn_callback_url: z.string().trim().max(500).optional(),
    rails: z.array(z.enum(['pix', 'bitcoin'])).min(1).max(2).optional(),
    expires_in_minutes: z.number().int().min(15).max(1440).optional(),
  })
  .strict();

const idParams = z.object({ id: z.string().uuid() });

/** Autenticacao das plataformas: so o header `x-api-key` (chave de loja). */
function storeKeyAuth(invoices: InvoiceService) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers['x-api-key'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) throw new UnauthorizedError('envie a chave de loja no header x-api-key');
    const { key, client } = await invoices.authenticate(value.trim());
    request.storeKey = key;
    request.storeClient = client;
  };
}

const PUBLIC_POST = { rateLimit: { max: 10, timeWindow: 60_000 } };

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Esqueleto da pagina; o /invoice.js busca o estado e monta o resto (CSP sem inline). */
function invoiceHtml(state: { id: string; merchant_name: string; price_amount: string; price_currency: string; description: string | null; mode: string }): string {
  const symbol = state.price_currency === 'USD' ? 'US$' : 'R$';
  const [int, frac] = state.price_amount.split('.');
  const value = `${symbol} ${(int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${frac ?? '00'}`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Pagamento ${escapeHtml(value)} · ${escapeHtml(state.merchant_name)}</title>
<link rel="stylesheet" href="/invoice.css">
</head>
<body>
<main class="invoice" id="invoice" data-id="${escapeHtml(state.id)}">
  ${state.mode === 'test' ? '<div class="test-banner">MODO TESTE · nenhum dinheiro é cobrado</div>' : ''}
  <header>
    <div class="merchant">${escapeHtml(state.merchant_name)}</div>
    <div class="amount">${escapeHtml(value)}</div>
    ${state.description ? `<div class="desc">${escapeHtml(state.description)}</div>` : ''}
  </header>
  <section id="app"><p class="muted">Carregando…</p></section>
  <footer>Pagamento processado por LibreFlow Pay</footer>
</main>
<script src="/invoice.js" defer></script>
</body>
</html>`;
}

export function registerInvoiceRoutes(app: FastifyInstance, deps: { invoices: InvoiceService }): void {
  const { invoices } = deps;
  const auth = { preHandler: storeKeyAuth(invoices) };

  // ---- API das plataformas (x-api-key)

  app.get('/v1/ping', auth, async (request) => ({
    ok: true,
    merchant_name: request.storeClient!.name,
    mode: request.storeKey!.mode,
  }));

  app.post('/v1/invoices', auth, async (request, reply) => {
    const body = parse(createSchema, request.body ?? {}, 'corpo');
    const { invoice, reused } = await invoices.create(request.storeClient!, request.storeKey!, request.storeKey!.mode, {
      priceAmount: body.price_amount,
      priceCurrency: body.price_currency,
      orderId: body.order_id,
      orderDescription: body.order_description,
      customerEmail: body.customer_email,
      successUrl: body.success_url,
      cancelUrl: body.cancel_url,
      ipnCallbackUrl: body.ipn_callback_url,
      rails: body.rails,
      expiresInMinutes: body.expires_in_minutes,
    });
    return reply.status(reused ? 200 : 201).send(invoices.dto(invoice));
  });

  app.get('/v1/invoices/:id', auth, async (request) => {
    const { id } = parse(idParams, request.params, 'fatura');
    const row = await invoices.findForClient(request.storeClient!.id, id);
    // Chave de teste so enxerga fatura de teste (e vice-versa).
    if (!row || row.mode !== request.storeKey!.mode) throw new NotFoundError('fatura nao encontrada');
    return invoices.dto(await invoices.sync(row));
  });

  app.get('/v1/invoices', auth, async (request) => {
    const query = parse(z.object({ order_id: z.string().trim().min(1).max(64) }), request.query, 'consulta');
    const row = await invoices.findByOrder(request.storeClient!.id, request.storeKey!.mode, query.order_id);
    if (!row) throw new NotFoundError('fatura nao encontrada');
    return invoices.dto(await invoices.sync(row));
  });

  // ---- pagina publica do pagador

  const html = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parse(idParams, request.params, 'fatura');
    const state = await invoices.publicState(id);
    return reply
      .header('cache-control', 'no-store')
      .header('x-robots-tag', 'noindex, nofollow')
      .type('text/html; charset=utf-8')
      .send(invoiceHtml(state));
  };
  app.get('/i/:id', html);

  app.get('/i/:id/state', async (request, reply) => {
    const { id } = parse(idParams, request.params, 'fatura');
    return reply.header('cache-control', 'no-store').send(await invoices.publicState(id));
  });

  app.post('/i/:id/pix', { config: PUBLIC_POST }, async (request) => {
    const { id } = parse(idParams, request.params, 'fatura');
    const body = parse(z.object({ payer_tax_number: z.string().trim().min(11).max(18) }).strict(), request.body ?? {}, 'corpo');
    return invoices.choosePix(id, body.payer_tax_number);
  });

  app.post('/i/:id/bitcoin', { config: PUBLIC_POST }, async (request) => {
    const { id } = parse(idParams, request.params, 'fatura');
    return invoices.chooseBitcoin(id);
  });

  app.post('/i/:id/simulate', { config: PUBLIC_POST }, async (request) => {
    const { id } = parse(idParams, request.params, 'fatura');
    const row = await invoices.simulatePayment(id);
    return { status: row.status };
  });
}
