import { contaApi, setConta } from '/app.js';

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const erro = document.getElementById('erro');
  erro.textContent = '';
  const senha = document.getElementById('senha').value;
  const identificador = document.getElementById('usuario').value.trim();
  try {
    await contaApi('/api/conta/criar', {
      method: 'POST',
      body: JSON.stringify({
        nome: document.getElementById('nome').value.trim(),
        email: document.getElementById('email').value.trim(),
        usuario: identificador,
        senha,
      }),
    });
    const entrada = await contaApi('/api/conta/entrar', {
      method: 'POST',
      body: JSON.stringify({ identificador, senha }),
    });
    setConta(entrada.token);
    window.location.assign('/painel.html');
  } catch (err) {
    erro.textContent = err.message || 'Erro no servidor';
  }
});
