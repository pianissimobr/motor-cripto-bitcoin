import type { FastifyInstance } from 'fastify';
import { NotFoundError } from '../domain/errors.js';
import type { PaymentIntentService } from '../services/payment-intent-service.js';

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
  <div class="kpi"><div class="value">${escapeHtml(value)}</div><div class="label" id="status">${escapeHtml(status)}</div></div>
  ${qr ? `<div class="qr" style="margin:16px auto">${qr}</div>` : ''}
  ${uri ? `<pre class="creds" id="uri">${escapeHtml(uri)}</pre>` : ''}
  ${address ? `<div class="muted">Endereço: <span style="word-break:break-all">${escapeHtml(address)}</span></div>` : ''}
  ${invoice ? `<div class="muted" style="margin-top:8px">Invoice Lightning: <span style="word-break:break-all">${escapeHtml(invoice)}</span></div>` : ''}
</div>
</main>
<script>
async function poll() {
  try {
    const res = await fetch(window.location.pathname + '/status');
    if (!res.ok) return;
    const data = await res.json();
    const node = document.getElementById('status');
    if (node && data.status) node.textContent = data.status;
    if (data.paid) window.location.reload();
  } catch {}
}
setInterval(poll, 5000);
</script>
</body>
</html>`;
}

export function registerCheckoutRoutes(
  app: FastifyInstance,
  deps: { paymentIntents: PaymentIntentService },
): void {
  app.get('/pay/:id', async (request, reply) => {
    const params = request.params as { id: string };
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