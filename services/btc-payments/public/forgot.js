import { solveAltcha } from '/altcha.js';

const askForm = document.getElementById('ask-form');
const resetForm = document.getElementById('reset-form');
const erro = document.getElementById('erro');
const info = document.getElementById('info');
let requestId = null;
let email = '';

askForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  erro.textContent = '';
  const button = askForm.querySelector('button');
  button.disabled = true;
  try {
    email = document.getElementById('email').value.trim();
    const payload = { email };
    const altcha = await solveAltcha();
    if (altcha) payload.altcha = altcha;
    const res = await fetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      erro.textContent = body?.error?.message ?? 'Falha ao pedir o código';
      return;
    }
    requestId = body.request_id ?? null;
    info.textContent = 'Se o e-mail tiver conta, um código de 6 dígitos foi enviado.';
    resetForm.classList.remove('hidden');
  } catch (err) {
    erro.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
  }
});

resetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  erro.textContent = '';
  const res = await fetch('/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      request_id: requestId,
      code: document.getElementById('code').value.trim(),
      password: document.getElementById('password').value,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    info.textContent = 'Senha trocada. Entre com a nova senha.';
    resetForm.classList.add('hidden');
    return;
  }
  erro.textContent = body?.error?.message ?? 'Código inválido';
});
