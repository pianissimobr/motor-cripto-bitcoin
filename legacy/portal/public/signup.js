import { solveAltcha } from '/altcha.js';

const form = document.getElementById('signup-form');
const erro = document.getElementById('erro');
const resultado = document.getElementById('resultado');

// As duas senhas precisam bater; "Mostrar senha" revela as duas.
function wirePasswords() {
  const a = document.getElementById('password');
  const b = document.getElementById('password2');
  document.getElementById('show-password')?.addEventListener('change', (e) => {
    const type = e.target.checked ? 'text' : 'password';
    a.type = type;
    b.type = type;
  });
  return () => {
    if (a.value.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
    if (a.value !== b.value) return 'As duas senhas não são iguais.';
    return '';
  };
}
const checkPasswords = wirePasswords();

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
    if (res.ok) {
      status.innerHTML = 'E-mail confirmado. <a href="/login.html">Entrar no portal</a>';
      document.getElementById('verify-form').classList.add('hidden');
      return;
    }
    status.textContent = body?.error?.message ?? 'Código inválido';
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  erro.textContent = '';
  resultado.textContent = '';
  const problema = checkPasswords();
  if (problema) {
    erro.textContent = problema;
    return;
  }
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
    // Nenhuma credencial aqui: elas sao geradas no portal, depois que o
    // e-mail estiver confirmado.
    form.classList.add('hidden');
    resultado.innerHTML =
      'Conta criada. Confirme o seu e-mail para entrar; as credenciais da API são geradas dentro do portal.' +
      (body.verification_token
        ? `<br>Token de verificação (dev): <code>${escapeHtml(body.verification_token)}</code>`
        : '');
    if (body.verification_request_id) {
      await confirmCode(email, body.verification_request_id);
    }
  } catch (err) {
    erro.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
  }
});
