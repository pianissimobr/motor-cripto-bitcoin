import type { FastifyInstance } from 'fastify';
import { NotFoundError } from '../domain/errors.js';
import type { PaymentIntentService } from '../services/payment-intent-service.js';
import type { PixChargeService } from '../services/pix-charge-service.js';

const STATUS_LABEL: Record<string, string> = {
  criando: 'Preparando',
  pendente: 'Aguardando pagamento',
  pago: 'Pago',
  parcial: 'Parcial',
  expirado: 'Expirado',
  pago_tardio: 'Pago (atrasado)',
  cancelado: 'Cancelado',
  reorg: 'Revertido (reorg)',
  falha_criacao: 'Falha ao criar',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function checkoutHtml(dto: Awaited<ReturnType<PaymentIntentService['getPublicById']>> & {}): string {
  if (!dto) return '';
  const value = `${dto.amount_sats} sats`;
  const status = STATUS_LABEL[dto.status] ?? dto.status;
  const qr = dto.qr_svg ? dto.qr_svg : '';
  const uri = dto.payment_uri ?? '';
  const address = dto.onchain?.address ?? null;
  const invoice = dto.lightning?.invoice ?? null;
  const railLabel =
    address && invoice
      ? 'Lightning ou on-chain'
      : invoice
        ? 'Lightning'
        : address
          ? 'On-chain'
          : '';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Pagamento ${escapeHtml(value)}</title>
<link rel="stylesheet" href="/portal.css">
</head>
<body>
<main>
<div class="card narrow" style="text-align:center">
  <h1>Pagamento</h1>
  <div class="muted">${escapeHtml(dto.description ?? '')}</div>
  ${railLabel ? `<div class="muted">${escapeHtml(railLabel)}</div>` : ''}
  <div class="kpi"><div class="value">${escapeHtml(value)}</div><div class="label" id="status">${escapeHtml(status)}</div></div>
  ${qr ? `<div class="qr" style="margin:16px auto">${qr}</div>` : ''}
  ${uri ? `<pre class="creds" id="uri">${escapeHtml(uri)}</pre>` : ''}
  ${address ? `<div class="muted">Endereço: <span style="word-break:break-all">${escapeHtml(address)}</span></div>` : ''}
  ${invoice ? `<div class="muted" style="margin-top:8px">Invoice Lightning: <span style="word-break:break-all">${escapeHtml(invoice)}</span></div>` : ''}
</div>
</main>
<script src="/pay-status.js" defer></script>
</body>
</html>`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O id da cobranca e o token publico; formato invalido e so "nao existe". */
function assertPublicId(id: string): void {
  if (!UUID_RE.test(id)) throw new NotFoundError('cobranca nao encontrada');
}

const PIX_STATUS_LABEL: Record<string, string> = {
  criando: 'Preparando',
  pendente: 'Aguardando pagamento',
  pago: 'Pago',
  liquidado: 'Pago (USDC entregue)',
  expirado: 'Expirado',
  reembolsado: 'Reembolsado',
  falhou: 'Falhou',
  incerto: 'Em analysis',
  manual: 'Em analysis',
};

function centsToBrl(cents: string): string {
  const value = BigInt(cents);
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, '0');
  return `R$ ${whole.toString()},${fraction}`;
}

/**
 * Pagina publica do checkout PIX (C9).
 *
 * O pagador nao tem conta: a pagina mostra o QR do Pix, o valor e o estado.
 * Nao expoe `client_id` nem dado do lojista.
 */
export function pixCheckoutHtml(dto: Awaited<ReturnType<PixChargeService['getPublicById']>>): string {
  const value = centsToBrl(dto.amount_brl_cents);
  const status = PIX_STATUS_LABEL[dto.status] ?? dto.status;
  const qr = dto.pix.qr_svg ?? '';
  const copy = dto.pix.qr_copypaste ?? '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Pagamento ${escapeHtml(value)}</title>
<link rel="stylesheet" href="/portal.css">
</head>
<body>
<main>
<div class="card narrow" style="text-align:center">
  <h1>Pagamento Pix</h1>
  <div class="muted">${escapeHtml(value)}</div>
  <div class="kpi"><div class="value">${escapeHtml(value)}</div><div class="label" id="status">${escapeHtml(status)}</div></div>
  ${qr ? `<div class="qr" style="margin:16px auto">${qr}</div>` : ''}
  ${copy ? `<pre class="creds" id="uri">${escapeHtml(copy)}</pre>` : ''}
  ${dto.e2e ? `<div class="muted">Comprovante: <span style="word-break:break-all">${escapeHtml(dto.e2e)}</span></div>` : ''}
</div>
</main>
<script src="/pay-status.js" defer></script>
</body>
</html>`;
}

export function registerCheckoutRoutes(
  app: FastifyInstance,
  deps: { paymentIntents: PaymentIntentService; pixCharges?: PixChargeService },
): void {
  app.get('/pay/:id', async (request, reply) => {
    const params = request.params as { id: string };
    assertPublicId(params.id);
    if (deps.pixCharges) {
      const pix = await deps.pixCharges.getPublicById(params.id).catch(() => null);
      if (pix) {
        return reply
          .header('cache-control', 'no-store')
          .header('x-robots-tag', 'noindex, nofollow')
          .type('text/html; charset=utf-8')
          .send(pixCheckoutHtml(pix));
      }
    }
    const dto = await deps.paymentIntents.getPublicById(params.id);
    if (!dto) throw new NotFoundError('cobranca nao encontrada');
    const html = checkoutHtml(dto);
    return reply
      .header('cache-control', 'no-store')
      .header('x-robots-tag', 'noindex, nofollow')
      .type('text/html; charset=utf-8')
      .send(html);
  });

  app.get('/pay/:id/status', async (request) => {
    const params = request.params as { id: string };
    assertPublicId(params.id);
    if (deps.pixCharges) {
      const pix = await deps.pixCharges.getPublicById(params.id).catch(() => null);
      if (pix) {
        return {
          status: PIX_STATUS_LABEL[pix.status] ?? pix.status,
          state: pix.status,
          settlement_status: pix.settlement_status,
          amount_brl_cents: pix.amount_brl_cents,
          paid: pix.status === 'pago' || pix.status === 'liquidado',
          paid_at: pix.paid_at,
          settled_at: pix.settled_at,
          e2e: pix.e2e,
        };
      }
    }
    const dto = await deps.paymentIntents.getPublicById(params.id);
    if (!dto) throw new NotFoundError('cobranca nao encontrada');
    const paid = dto.status === 'pago' || dto.status === 'pago_tardio';
    return {
      status: STATUS_LABEL[dto.status] ?? dto.status,
      amount_sats: dto.amount_sats,
      paid,
      paid_amount_sats: dto.paid_amount_sats,
      paid_at: dto.paid_at,
      expires_at: dto.expires_at,
    };
  });
}