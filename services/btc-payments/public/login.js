import { solveAltcha } from '/altcha.js';

const form = document.getElementById('login-form');
const erro = document.getElementById('erro');
const verifyBox = document.getElementById('verify-box');
const verifyStatus = document.getElementById('verify-status');
let requestId = null;

function email() {
  return document.getElementById('email').value.trim();
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { res, body: await res.json().catch(() => ({})) };
}

async function login() {
  const payload = { email: email(), password: document.getElementById('password').value };
  const altcha = await solveAltcha();
  if (altcha) payload.altcha = altcha;
  const { res, body } = await post('/auth/login', payload);
  if (res.ok) {
    window.location.href = '/app.html';
    return;
  }
  if (body?.error?.code === 'email_not_verified') {
    verifyBox.classList.remove('hidden');
    erro.textContent = 'Confirme o seu e-mail para entrar.';
    return;
  }
  erro.textContent = body?.error?.message ?? 'Falha ao entrar';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  erro.textContent = '';
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await login();
  } catch (err) {
    erro.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('resend').addEventListener('click', async () => {
  verifyStatus.textContent = 'Enviando...';
  try {
    const payload = { email: email() };
    const altcha = await solveAltcha();
    if (altcha) payload.altcha = altcha;
    const { res, body } = await post('/auth/resend-verification', payload);
    if (!res.ok) {
      verifyStatus.textContent = body?.error?.message ?? 'Falha ao reenviar';
      return;
    }
    requestId = body.request_id ?? null;
    verifyStatus.textContent = body.verification_token
      ? `Token (dev): ${body.verification_token}`
      : 'Código enviado para o seu e-mail.';
  } catch (err) {
    verifyStatus.textContent = err instanceof Error ? err.message : String(err);
  }
});

document.getElementById('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requestId) {
    verifyStatus.textContent = 'Clique em "Reenviar código" primeiro.';
    return;
  }
  const { res, body } = await post('/auth/verify-email', {
    email: email(),
    request_id: requestId,
    code: document.getElementById('verify-code').value.trim(),
  });
  if (!res.ok) {
    verifyStatus.textContent = body?.error?.message ?? 'Código inválido';
    return;
  }
  verifyStatus.textContent = 'E-mail confirmado. Entrando...';
  await login();
});
