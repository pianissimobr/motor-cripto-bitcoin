const form = document.getElementById('signup-form');
const erro = document.getElementById('erro');
const resultado = document.getElementById('resultado');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  erro.textContent = '';
  resultado.textContent = '';
  const payload = {
    email: document.getElementById('email').value,
    password: document.getElementById('password').value,
  };
  const merchant = document.getElementById('merchant').value.trim();
  if (merchant) payload.merchant_name = merchant;

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
    `Token de verificação (dev): <code>${escapeHtml(body.verification_token ?? '')}</code>. ` +
    '<a href="/login.html">Ir para o login</a>';
});
function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
