import { loadMarket } from '/market.js';

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

async function generateCredentials() {
  const ok = window.confirm(
    'Gerar novas credenciais? As atuais deixam de funcionar na hora e o seu site precisará das novas.',
  );
  if (!ok) return;
  el('erro').textContent = '';
  try {
    const data = await api('POST', `/v1/portal/merchants/${state.merchantId}/credentials`, {});
    const out = el('credentials-out');
    out.textContent =
      `API key:         ${data.api_key}\n` +
      `Request secret:  ${data.request_secret}\n` +
      `Webhook secret:  ${data.webhook_secret}\n\n` +
      'Guarde agora: estes segredos não serão mostrados de novo.';
    out.classList.remove('hidden');
    el('api-key-prefix').textContent = `${data.api_key.slice(0, 20)}…`;
  } catch (err) {
    showError(err);
  }
}

async function loadWebhook() {
  const data = await api('GET', `/v1/portal/merchants/${state.merchantId}`);
  el('api-key-prefix').textContent = data.api_key_prefix ? `${data.api_key_prefix}…` : '—';
  el('credentials-out').classList.add('hidden');
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

const WALLET_KINDS = ['lightning_lnbits', 'btc_deposit', 'usdc_settlement'];

async function loadWallets() {
  const data = await api('GET', `/v1/portal/merchants/${state.merchantId}/wallets`);
  const list = (data.data ?? []).filter((w) => w.status === 'ativo');
  for (const kind of WALLET_KINDS) {
    const node = el(`wallet-current-${kind}`);
    const w = list.find((x) => x.kind === kind);
    node.innerHTML = '';
    if (!w) {
      node.innerHTML = '<span class="muted">Não cadastrada.</span>';
      continue;
    }
    const row = document.createElement('div');
    row.className = 'row';
    const info = document.createElement('div');
    info.style.flex = '1';
    info.innerHTML =
      '<strong>Cadastrada:</strong> ' +
      `<span class="valor">${escapeHtml(w.lnbits_url ?? w.xpub ?? w.address)}</span>` +
      '<div class="muted">Salvar outra substitui esta.</div>';
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

// ---- Valor do checkout: R$, US$ ou sats; o campo digitado manda ----
const fx = { brl: null, usd: null, source: null };
const AMOUNT_FIELDS = { brl: 'amt-brl', usd: 'amt-usd', sats: 'amt-sats' };
const money2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('pt-BR');

/** "1.234,56", "1234.56", "50" -> 1234.56. O ultimo separador seguido de 1-2 digitos e o decimal. */
function parseMoney(text) {
  const t = String(text).replace(/[^\d.,]/g, '');
  if (!t) return null;
  const m = t.match(/^(.*?)[.,](\d{1,2})$/);
  const whole = (m ? m[1] : t).replace(/[.,]/g, '');
  const n = Number(`${whole || '0'}.${m ? m[2] : '0'}`);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseSats(text) {
  const t = String(text).replace(/\D/g, '');
  const n = t ? Number(t) : null;
  return n && Number.isSafeInteger(n) ? n : null;
}

function updateAmounts(source) {
  if (source) fx.source = source;
  const src = fx.source;
  const hint = el('amt-hint');
  for (const [key, id] of Object.entries(AMOUNT_FIELDS)) {
    el(id).classList.toggle('calc', Boolean(src) && key !== src);
  }
  if (!src) return;
  const raw = el(AMOUNT_FIELDS[src]).value;
  let sats = null;
  if (src === 'sats') sats = parseSats(raw);
  else if (fx[src]) {
    const v = parseMoney(raw);
    sats = v ? Math.floor((v * 1e8) / fx[src]) : null;
  }
  for (const key of ['brl', 'usd', 'sats']) {
    if (key === src) continue;
    const input = el(AMOUNT_FIELDS[key]);
    if (sats === null) input.value = '';
    else if (key === 'sats') input.value = intFmt.format(sats);
    else input.value = fx[key] ? money2.format((sats / 1e8) * fx[key]) : '';
  }
  if (sats !== null) {
    const btc = (sats / 1e8).toLocaleString('pt-BR', { minimumFractionDigits: 8, maximumFractionDigits: 8 });
    hint.textContent = `= ${btc} BTC. ${src === 'sats' ? 'Cobrança fixa em sats.' : 'A cotação é travada ao gerar o QR.'}`;
  } else {
    showRateHint();
  }
}

function showRateHint() {
  const hint = el('amt-hint');
  if (fx.brl || fx.usd) {
    const parts = [];
    if (fx.brl) parts.push(`R$ ${money2.format(fx.brl)}`);
    if (fx.usd) parts.push(`US$ ${money2.format(fx.usd)}`);
    hint.textContent = `1 BTC = ${parts.join(' · ')}`;
  } else {
    hint.textContent = 'Cotação indisponível agora: informe o valor em sats.';
  }
}

async function loadRates() {
  try {
    const data = await api('GET', '/v1/portal/fx/rates');
    for (const r of data.rates ?? []) {
      const price = Number(r.btc_price_cents) / 100;
      if (r.currency === 'BRL') fx.brl = price;
      if (r.currency === 'USD') fx.usd = price;
    }
  } catch {
    fx.brl = null;
    fx.usd = null;
  }
  el('amt-brl').disabled = !fx.brl;
  el('amt-usd').disabled = !fx.usd;
  if (fx.source && fx.source !== 'sats' && !fx[fx.source]) fx.source = null;
  updateAmounts();
  if (!fx.source) showRateHint();
}

async function submitPixCheckout(e) {
  e.preventDefault();
  const value = parseMoney(el('pix-amount').value);
  if (!value) {
    showError(new Error('Informe o valor em R$.'));
    return;
  }
  const tax = el('pix-tax').value.replace(/\D/g, '');
  if (tax.length !== 11 && tax.length !== 14) {
    showError(new Error('CPF/CNPJ do pagador invalido.'));
    return;
  }
  const name = el('pix-name').value.trim();
  const description = el('pix-desc').value.trim();
  el('erro').textContent = '';
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const data = await api('POST', `/v1/portal/merchants/${state.merchantId}/pix-checkout`, {
      amount_cents: String(Math.round(value * 100)),
      payer_tax_number: tax,
      ...(name ? { payer_name: name } : {}),
      ...(description ? { description } : {}),
    });
    el('pix-checkout-result').classList.remove('hidden');
    el('pix-checkout-qr').innerHTML = data.pix?.qr_svg ?? '';
    el('pix-checkout-uri').textContent = data.pix?.qr_copypaste ?? '';
    const link = el('pix-checkout-link');
    link.href = data.checkout_url ?? `/pay/${data.id}`;
    link.classList.remove('hidden');
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
  }
}

async function submitCheckout(e) {
  e.preventDefault();
  const description = el('checkout-desc').value.trim();
  const src = fx.source;
  let amount;
  if (src === 'sats') {
    const sats = parseSats(el('amt-sats').value);
    if (sats) amount = { amount_sats: String(sats) };
  } else if (src === 'brl' || src === 'usd') {
    const v = parseMoney(el(AMOUNT_FIELDS[src]).value);
    if (v) amount = { amount: String(Math.round(v * 100)), currency: src.toUpperCase() };
  }
  if (!amount) {
    showError(new Error('Informe o valor em R$, US$ ou sats.'));
    return;
  }
  el('erro').textContent = '';
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const data = await api('POST', `/v1/portal/merchants/${state.merchantId}/checkout`, {
      ...amount,
      ...(description ? { description } : {}),
    });
    el('checkout-result').classList.remove('hidden');
    const qr = data.qr_svg ?? '';
    el('checkout-qr').innerHTML = qr;
    el('checkout-uri').textContent = data.payment_uri ?? '';
    // Mostra o valor que realmente ficou na cobranca (cotacao travada).
    if (data.amount_sats) {
      el('amt-sats').value = intFmt.format(Number(data.amount_sats));
    }
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
  } finally {
    button.disabled = false;
  }
}

async function submitWallet(e) {
  e.preventDefault();
  const form = e.target;
  const kind = form.dataset.kind;
  const field = (name) => form.elements[name].value.trim();
  const body =
    kind === 'lightning_lnbits'
      ? { kind, lnbits_url: field('lnbits_url'), invoice_key: field('invoice_key') }
      : kind === 'btc_deposit'
        ? { kind, xpub: field('xpub') }
        : {
            kind,
            address: field('address'),
            purpose: field('purpose') || 'loja',
            ...(field('purpose') === 'cliente'
              ? {
                  proof: {
                    nonce: field('proof_nonce'),
                    signature: field('proof_signature'),
                  },
                }
              : {}),
          };
  el('erro').textContent = '';
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('POST', `/v1/portal/merchants/${state.merchantId}/wallets`, body);
    form.reset();
    await loadWallets();
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
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
  el('pix-checkout-form').addEventListener('submit', submitPixCheckout);
  for (const form of document.querySelectorAll('.wallet-form')) {
    form.addEventListener('submit', submitWallet);
  }
  el('subscription-form').addEventListener('submit', submitSubscription);
  el('webhook-form').addEventListener('submit', submitWebhook);
  el('gen-credentials').addEventListener('click', () => void generateCredentials());
  for (const key of Object.keys(AMOUNT_FIELDS)) {
    el(AMOUNT_FIELDS[key]).addEventListener('input', () => updateAmounts(key));
  }
  try {
    const me = await fetch('/auth/me');
    if (!me.ok) {
      window.location.href = '/login.html';
      return;
    }
    await loadMerchants();
  } catch (err) {
    window.location.href = '/login.html';
    return;
  }
  void loadRates();
  void loadMarket();
  setInterval(() => void loadRates(), 60_000);
  setInterval(() => void loadMarket(), 5 * 60_000);
}

void init();