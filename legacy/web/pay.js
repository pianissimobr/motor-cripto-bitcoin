const LABELS = {
  aguardando: 'Aguardando pagamento',
  pago: 'Pagamento confirmado',
  parcial: 'Pagamento parcial recebido',
  pago_sem_gas: 'Pagamento recebido',
  movido: 'Pagamento concluido',
  expirado: 'Pagina expirada',
  nao_realizado: 'Pagamento nao realizado',
};

const MOTIVOS = {
  nao_pago: 'Nenhum pagamento foi identificado.',
  valor_parcial: 'O valor recebido foi menor que o valor cobrado.',
  pagamento_apos_prazo: 'O pagamento chegou depois do prazo de liquidacao.',
  revogado: 'O link foi revogado pelo recebedor.',
  reorg: 'O pagamento foi revertido pela rede.',
};

const TERMINAL = new Set(['pago', 'pago_sem_gas', 'movido', 'nao_realizado', 'expirado']);

const token = location.pathname.split('/').filter(Boolean).pop();
const statusEl = document.getElementById('status');
const receivedEl = document.getElementById('received');
const motivoEl = document.getElementById('motivo');
const payEl = document.getElementById('pay');

function formatBaseUnits(value, decimals) {
  const raw = BigInt(value);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : String(whole);
  return negative ? `-${text}` : text;
}

async function refresh() {
  if (!token || !statusEl) return;
  const response = await fetch(`/p/${encodeURIComponent(token)}/status`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return;
  const data = await response.json();
  const status = data.status;
  statusEl.className = `status ${status}`;
  statusEl.textContent = LABELS[status] ?? status;

  if (receivedEl) {
    const received = BigInt(data.valor_recebido_base_units ?? '0');
    if (received > 0n) {
      receivedEl.hidden = false;
      receivedEl.textContent = `Recebido: ${formatBaseUnits(received, data.decimals)} ${data.asset}`;
    }
  }

  if (motivoEl) {
    const motivo = data.motivo_nao_realizado ? MOTIVOS[data.motivo_nao_realizado] ?? data.motivo_nao_realizado : '';
    motivoEl.hidden = motivo === '';
    motivoEl.textContent = motivo;
  }

  if (payEl) payEl.hidden = TERMINAL.has(status);
}

refresh();
setInterval(refresh, 4000);
