const form = document.getElementById('login-form');
const erro = document.getElementById('erro');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  erro.textContent = '';
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) {
    window.location.href = '/app.html';
    return;
  }
  const body = await res.json().catch(() => ({}));
  erro.textContent = body?.error?.message ?? 'Falha ao entrar';
});
