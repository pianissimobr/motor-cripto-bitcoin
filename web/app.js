/**
 * Helpers compartilhados pelas paginas do motor.
 * Sem framework, sem CDN: tudo local e sem dependencia externa.
 */

const TOKEN_KEY = 'motor.admin.token';

export function getConta() {
  return sessionStorage.getItem('motor.conta.token') || '';
}

export function setConta(value) {
  if (value) sessionStorage.setItem('motor.conta.token', value);
  else sessionStorage.removeItem('motor.conta.token');
}

/** Chamadas da conta do cliente. Não envia o token da loja. */
export async function contaApi(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const token = getConta();
  if (token) headers['x-conta-token'] = token;
  const response = await fetch(path, Object.assign({}, options, { headers }));
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { erro: text.slice(0, 200) };
    }
  }
  if (!response.ok) {
    const message = (body && (body.erro || body.message)) || `Erro no servidor (HTTP ${response.status})`;
    const error = new Error(response.status >= 500 ? 'Erro no servidor' : message);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(value) {
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export async function api(path, options = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(path, Object.assign({}, options, { headers }));
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { erro: text.slice(0, 200) };
    }
  }
  if (!response.ok) {
    const message = (body && (body.erro || body.message)) || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function toast(message, kind = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

export function fmtBRL(cents) {
  if (cents === null || cents === undefined) return '-';
  const value = Number(cents) / 100;
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function fmtDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('pt-BR');
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

export function maskEmail(email) {
  if (!email) return '-';
  const at = email.lastIndexOf('@');
  if (at < 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  const name = dot >= 0 ? domain.slice(0, dot) : domain;
  const tld = dot >= 0 ? domain.slice(dot) : '';
  return `${local[0] || '*'}***@${name[0] || '*'}***${tld}`;
}

export function baseUnitsToDecimal(value, decimals) {
  const raw = BigInt(value);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  const frac = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function statusBadge(status) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

/** Barra de autenticacao: guarda o token admin em sessionStorage. */
export function setupAuth() {
  const input = document.getElementById('token-input');
  const state = document.getElementById('auth-state');
  const save = document.getElementById('token-save');
  if (!input || !state || !save) return;

  input.value = getToken();

  const check = async () => {
    if (!getToken()) {
      state.textContent = 'sem token';
      state.className = 'auth-state';
      return false;
    }
    try {
      const data = await api('/api/auth/check');
      state.textContent =
        data.escopo === 'readonly' ? 'token valido (leitura)' : 'token valido';
      state.className = 'auth-state ok';
      return true;
    } catch (err) {
      state.textContent = err.status === 401 || err.status === 403 ? 'token invalido' : 'erro de rede';
      state.className = 'auth-state bad';
      return false;
    }
  };

  save.addEventListener('click', async () => {
    setToken(input.value.trim());
    const ok = await check();
    toast(ok ? 'Token salvo nesta aba' : 'Token invalido', ok ? 'ok' : 'err');
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save.click();
  });

  check();
}
