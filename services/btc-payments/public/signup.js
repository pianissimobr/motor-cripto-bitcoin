import { solveAltcha } from '/altcha.js';

const form = document.getElementById('signup-form');
const erro = document.getElementById('erro');
const resultado = document.getElementById('resultado');

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function confirmCode(email, requestId) {
  const box = document.getElementById('verify-box');
  const status = document.getElementById('verify-status');
  box.classList.remove('hidden');
  document.getElementById('verify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    const res = await fetch('/auth/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        request_id: requestId,
        code: document.getElementById('verify-code').value.trim(),
      }),
    });
    const body = await res.json().catch(() => ({}));
    status.textContent = res.ok
      ? 'E-mail confirmado. Já pode entrar.'
      : (body?.error?.message ?? 'Código inválido');
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  erro.textContent = '';
  resultado.textContent = '';
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const email = document.getElementById('email').value;
    const payload = { email, password: document.getElementById('password').value };
    const merchant = document.getElementById('merchant').value.trim();
    if (merchant) payload.merchant_name = merchant;
    const altcha = await solveAltcha();
    if (altcha) payload.altcha = altcha;

    const res = await fetch('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      erro.textContent = body?.error?.message ?? 'Falha ao cadastrar';
      return;
    }
    resultado.innerHTML =
      'Conta criada. Guarde suas credenciais da API (são mostradas uma única vez).<br>' +
      `<pre class="creds">${escapeHtml(JSON.stringify(body.merchant, null, 2))}</pre>` +
      (body.verification_token
        ? `Token de verificação (dev): <code>${escapeHtml(body.verification_token)}</code>. `
        : '') +
      '<a href="/login.html">Ir para o login</a>';
    if (body.verification_request_id) {
      await confirmCode(email, body.verification_request_id);
    }
  } catch (err) {
    erro.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
  }
});
