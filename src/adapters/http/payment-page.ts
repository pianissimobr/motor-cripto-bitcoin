import { qrCodeSvg, svgToDataUri } from '../../core/qrcode.js';
import type { PaymentLink } from '../../core/domain/types.js';
import { centsToFiat } from '../../core/domain/money.js';

const STATUS_LABEL: Record<PaymentLink['status'], string> = {
  aguardando: 'Aguardando pagamento',
  pago: 'Pagamento confirmado',
  parcial: 'Pagamento parcial recebido',
  pago_sem_gas: 'Pagamento recebido',
  movido: 'Pagamento concluido',
  expirado: 'Pagina expirada',
  nao_realizado: 'Pagamento nao realizado',
};

const MOTIVO_LABEL: Record<string, string> = {
  nao_pago: 'Nenhum pagamento foi identificado.',
  valor_parcial: 'O valor recebido foi menor que o valor cobrado.',
  pagamento_apos_prazo: 'O pagamento chegou depois do prazo de liquidacao.',
  revogado: 'O link foi revogado pelo recebedor.',
  reorg: 'O pagamento foi revertido pela rede.',
};

export async function renderPaymentPage(link: PaymentLink): Promise<string> {
  const qr = await qrCodeSvg(link.rampUrl, { width: 240 }).catch(() => null);
  const qrImg = qr ? `<img class="qr" alt="QR code para pagamento" src="${svgToDataUri(qr)}">` : '';
  const terminal = ['pago', 'pago_sem_gas', 'movido', 'nao_realizado'].includes(link.status);
  const podePagar = !terminal && link.status !== 'expirado';
  const valor = formatCents(link.valorFiatCentavos, link.moedaFiat);
  const recebido = formatBaseUnits(link.valorRecebidoBaseUnits, link.decimals, link.asset);
  const motivo =
    link.motivoNaoRealizado !== null
      ? MOTIVO_LABEL[link.motivoNaoRealizado] ?? link.motivoNaoRealizado
      : null;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Pagamento ${escapeHtml(valor)}</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fb;--card:#fff;--ink:#101828;--muted:#667085;--line:#e4e7ec;--accent:#0b5fff;--ok:#027a48;--warn:#b54708;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f16;--card:#121826;--ink:#f2f4f7;--muted:#98a2b3;--line:#1f2937;--accent:#5b8cff;--ok:#32d583;--warn:#fdb022;--bad:#f97066}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:440px;width:100%;padding:28px;box-shadow:0 12px 40px rgba(16,24,40,.08)}
h1{font-size:18px;margin:0 0 4px}p{margin:0}.muted{color:var(--muted);font-size:14px}
.amount{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:18px 0 4px}
.status{display:inline-block;margin-top:14px;padding:6px 10px;border-radius:999px;font-size:13px;font-weight:600;background:var(--bg);border:1px solid var(--line)}
.status.pago,.status.movido,.status.pago_sem_gas{color:var(--ok)}.status.parcial,.status.expirado{color:var(--warn)}.status.nao_realizado{color:var(--bad)}
.qr{display:block;width:240px;height:240px;margin:24px auto;border-radius:12px;background:#fff;padding:8px}
.addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px;margin:14px 0}
.btn{display:block;text-align:center;text-decoration:none;background:var(--accent);color:#fff;font-weight:700;padding:14px 18px;border-radius:12px;margin-top:18px}
.note{font-size:12px;color:var(--muted);margin-top:14px}
.received{font-size:14px;margin-top:8px}
</style>
</head>
<body>
<main class="card">
  <h1>Pagamento</h1>
  <p class="muted">${escapeHtml(link.asset)} na rede ${escapeHtml(link.chain)}</p>
  <div class="amount">${escapeHtml(valor)}</div>
  <div class="status ${link.status}">${escapeHtml(STATUS_LABEL[link.status])}</div>
  ${link.valorRecebidoBaseUnits > 0n ? `<p class="received">Recebido: ${escapeHtml(recebido)}</p>` : ''}
  ${motivo ? `<p class="note">${escapeHtml(motivo)}</p>` : ''}
  ${qrImg}
  ${podePagar ? `<a class="btn" href="${escapeHtml(link.rampUrl)}" rel="noopener noreferrer">Pagar com Ramp</a>` : ''}
  <div class="addr">Endereco de deposito:<br>${escapeHtml(link.enderecoDeposito)}</div>
  <p class="note">Esta pagina expira em ${escapeHtml(link.expiraEm.toLocaleString('pt-BR'))}. O pagamento on-chain continua sendo verificado ate ${escapeHtml(link.liquidacaoAte.toLocaleString('pt-BR'))}.</p>
</main>
</body>
</html>`;
}

function formatCents(cents: number, currency: string): string {
  const value = centsToFiat(cents);
  return currency === 'BRL' ? `R$ ${value}` : `${currency} ${value}`;
}

function formatBaseUnits(value: bigint, decimals: number, asset: string): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${asset}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
