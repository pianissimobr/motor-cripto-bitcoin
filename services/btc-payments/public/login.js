import { solveAltcha } from '/altcha.js';

const form = document.getElementById('login-form');
const erro = document.getElementById('erro');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  erro.textContent = '';
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const payload = {
      email: document.getElementById('email').value,
      password: document.getElementById('password').value,
    };
    const altcha = await solveAltcha();
    if (altcha) payload.altcha = altcha;
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      window.location.href = '/app.html';
      return;
    }
    const body = await res.json().catch(() => ({}));
    erro.textContent = body?.error?.message ?? 'Falha ao entrar';
  } catch (err) {
    erro.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
  }
});
