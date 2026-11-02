const COOKIE_SID = 'portal_sid';
const COOKIE_CSRF = 'portal_csrf';

function getCookie(name) {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET') {
    const csrf = getCookie(COOKIE_CSRF);
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  }
  return data;
}

function el(id) {
  return document.getElementById(id);
}

function showError(err) {
  const node = el('erro');
  node.textContent = err instanceof Error ? err.message : String(err);
}

const state = {
  merchants: [],
  merchantId: null,
};

async function loadMerchants() {
  const data = await api('GET', '/v1/portal/merchants');
  state.merchants = data.data ?? [];
  const select = el('merchant-select');
  select.innerHTML = '';
  for (const m of state.merchants) {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.name;
    select.appendChild(option);
  }
  if (state.merchants.length === 0) {
    select.innerHTML = '<option value="">Sem lojas</option>';
    return;
  }
  state.merchantId = select.value;
  select.addEventListener('change', () => {
    state.merchantId = select.value;
    void refresh();
  });
  void refresh();
}

async function refresh() {
  if (!state.merchantId) return;
  await Promise.all([
    loadWallets(),
    loadIntents(),
    loadKpis(),
    loadSubscriptions(),
    loadWebhook(),
  ]);
}

async function loadWebhook() {
  const data = await api('GET', `/v1/portal/merchants/${state.merchantId}`);
  el('webhook-url').value = data.webhook_url ?? '';
  el('webhook-status').textContent = data.webhook_url
    ? 'Webhook configurado.'
    : 'Nenhum webhook configurado: a loja não recebe avisos.';
}

async function submitWebhook(e) {
  e.preventDefault();
  el('erro').textContent = '';
  try {
    const data = await api('PATCH', `/v1/portal/merchants/${state.merchantId}`, {
      webhook_url: el('webhook-url').value.trim(),
    });
    el('webhook-status').textContent = data.webhookUrl
      ? 'Webhook salvo.'
      : 'Webhook removido: a loja não recebe avisos.';
  } catch (err) {
    showError(err);
  }
}

async function loadWallets() {
  const data = await api('GET', `/v1/portal/merchants/${state.merchantId}/wallets`);
  const list = (data.data ?? []).filter((w) => w.status === 'ativo');
  const node = el('wallets');
  node.innerHTML = '';
  const labels = {
    lightning_lnbits: 'Lightning (LNbits)',
    btc_deposit: 'BTC on-chain (xpub)',
    usdc_settlement: 'USDC Base (PIX)',
  };
  for (const w of list) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginBottom = '8px';
    const info = document.createElement('div');
    info.style.flex = '1';
    info.innerHTML =
      `<strong>${escapeHtml(labels[w.kind] ?? w.kind)}</strong>` +
      `<div class="muted" style="word-break:break-all">${escapeHtml(w.lnbits_url ?? w.xpub ?? w.address)}</div>`;
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Remover';
    del.addEventListener('click', () => void removeWallet(w.id));
    row.appendChild(info);
    row.appendChild(del);
    node.appendChild(row);
  }
}

async function removeWallet(walletId) {
  try {
    await api('DELETE', `/v1/portal/merchants/${state.merchantId}/wallets/${walletId}`);
    await loadWallets();
  } catch (err) {
    showError(err);
  }
}

async function loadIntents() {
  const data = await api('GET', `/v1/portal/merchants/${state.merchantId}/intents?limit=50`);
  const rows = data.data ?? [];
  const tbody = el('intents').querySelector('tbody');
  tbody.innerHTML = '';
  for (const intent of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${escapeHtml(intent.status)}</td>` +
      `<td>${escapeHtml(intent.amount_sats)} sats</td>` +
      `<td>${escapeHtml(intent.paid_rail ?? '—')}</td>` +
      `<td>${escapeHtml(new Date(intent.created_at).toLocaleString())}</td>`;
    tbody.appendChild(tr);
  }
}

async function loadKpis() {
  const data = await api('GET', `/v1/portal/merchants/${state.merchantId}/intents?limit=200`);
  const rows = data.data ?? [];
  const paid = rows.filter((r) => r.status === 'pago' || r.status === 'pago_tardio');
  const totalSats = rows.reduce((sum, r) => sum + BigInt(r.amount_sats), 0n);
  const cells = el('kpis').querySelectorAll('.value');
  cells[0].textContent = totalSats.toString();
  cells[1].textContent = String(rows.length);
  cells[2].textContent = String(paid.length);
  cells[3].textContent = rows.length ? `${Math.round((paid.length / rows.length) * 100)}%` : '—';
}

async function submitCheckout(e) {
  e.preventDefault();
  const sats = el('checkout-sats').value.trim();
  const description = el('checkout-desc').value.trim();
  try {
    const data = await api('POST', `/v1/portal/merchants/${state.merchantId}/checkout`, {
      amount_sats: sats,
      ...(description ? { description } : {}),
    });
    el('checkout-result').classList.remove('hidden');
    const qr = data.qr_svg ?? '';
    el('checkout-qr').innerHTML = qr;
    el('checkout-uri').textContent = data.payment_uri ?? '';
    const link = el('checkout-link');
    if (data.id) {
      link.href = `/pay/${data.id}`;
      link.classList.remove('hidden');
    } else {
      link.classList.add('hidden');
    }
    await loadIntents();
    await loadKpis();
  } catch (err) {
    showError(err);
  }
}

async function submitWallet(e) {
  e.preventDefault();
  const kind = el('wallet-kind').value;
  const body =
    kind === 'lightning_lnbits'
      ? {
          kind,
          lnbits_url: el('wallet-lnbits-url').value.trim(),
          invoice_key: el('wallet-lnbits-key').value.trim(),
        }
      : kind === 'btc_deposit'
        ? { kind, xpub: el('wallet-xpub').value.trim() }
        : { kind, address: el('wallet-addr').value.trim() };
  el('erro').textContent = '';
  try {
    await api('POST', `/v1/portal/merchants/${state.merchantId}/wallets`, body);
    el('wallet-lnbits-key').value = '';
    await loadWallets();
  } catch (err) {
    showError(err);
  }
}

async function loadSubscriptions() {
  const data = await api('GET', `/v1/portal/merchants/${state.merchantId}/subscriptions`);
  const rows = data.data ?? [];
  const node = el('subscriptions');
  node.innerHTML = '';
  for (const sub of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginBottom = '10px';
    const info = document.createElement('div');
    info.style.flex = '1';
    const actions = ['pausada', 'falha']
      .includes(sub.status) ? 'resume' : 'pause';
    info.innerHTML =
      `<strong>${escapeHtml(sub.name)}</strong> — ${escapeHtml(sub.amount_sats)} sats / ${escapeHtml(sub.interval)} ` +
      `<span class="muted">[${escapeHtml(sub.status)}]</span>`;
    const pause = document.createElement('button');
    pause.className = 'ghost';
    pause.textContent = actions === 'pause' ? 'Pausar' : 'Retomar';
    pause.addEventListener('click', () => void subAction(sub.id, actions));
    const cancel = document.createElement('button');
    cancel.className = 'danger';
    cancel.textContent = 'Cancelar';
    cancel.addEventListener('click', () => void subAction(sub.id, 'cancel'));
    row.appendChild(info);
    row.appendChild(pause);
    row.appendChild(cancel);
    node.appendChild(row);
  }
}

async function subAction(subId, action) {
  try {
    await api('POST', `/v1/portal/merchants/${state.merchantId}/subscriptions/${subId}/${action}`);
    await loadSubscriptions();
  } catch (err) {
    showError(err);
  }
}

async function submitSubscription(e) {
  e.preventDefault();
  try {
    await api('POST', `/v1/portal/merchants/${state.merchantId}/subscriptions`, {
      name: el('sub-name').value.trim(),
      amount_sats: el('sub-sats').value.trim(),
      interval: el('sub-interval').value,
    });
    e.target.reset();
    await loadSubscriptions();
  } catch (err) {
    showError(err);
  }
}

function toggleWalletKind() {
  const kind = el('wallet-kind').value;
  el('wallet-lnbits-url-label').classList.toggle('hidden', kind !== 'lightning_lnbits');
  el('wallet-lnbits-key-label').classList.toggle('hidden', kind !== 'lightning_lnbits');
  el('wallet-xpub-label').classList.toggle('hidden', kind !== 'btc_deposit');
  el('wallet-addr-label').classList.toggle('hidden', kind !== 'usdc_settlement');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function init() {
  el('logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });
  el('checkout-form').addEventListener('submit', submitCheckout);
  el('wallet-form').addEventListener('submit', submitWallet);
  el('subscription-form').addEventListener('submit', submitSubscription);
  el('webhook-form').addEventListener('submit', submitWebhook);
  el('wallet-kind').addEventListener('change', toggleWalletKind);
  toggleWalletKind();
  try {
    const me = await fetch('/auth/me');
    if (!me.ok) {
      window.location.href = '/login.html';
      return;
    }
    await loadMerchants();
  } catch (err) {
    window.location.href = '/login.html';
  }
}

void init();