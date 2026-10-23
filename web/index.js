import { contaApi, getConta, setConta } from '/app.js';

if (getConta()) {
  window.location.replace('/painel.html');
}

const form = document.getElementById('login');
document.getElementById('mostrar-login').addEventListener('click', () => {
  form.hidden = false;
  document.getElementById('identificador').focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const erro = document.getElementById('erro');
  erro.textContent = '';
  try {
    const data = await contaApi('/api/conta/entrar', {
      method: 'POST',
      body: JSON.stringify({
        identificador: document.getElementById('identificador').value.trim(),
        senha: document.getElementById('senha').value,
      }),
    });
    setConta(data.token);
    window.location.assign('/painel.html');
  } catch (err) {
    erro.textContent = err.message || 'Erro no servidor';
  }
});
