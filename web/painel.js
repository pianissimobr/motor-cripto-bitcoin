import { contaApi, getConta, setConta } from '/app.js';

if (!getConta()) window.location.replace('/index.html');

const modal = document.getElementById('modal');
const valor = document.getElementById('valor');

function moeda(texto) {
  let limpo = texto.replace(/[^\d,]/g, '');
  const partes = limpo.split(',');
  if (partes.length > 2) limpo = `${partes[0]},${partes.slice(1).join('')}`;
  const [inteiro, frac] = limpo.split(',');
  if (frac === undefined) return inteiro;
  return `${inteiro},${frac.slice(0, 2)}`;
}

valor.addEventListener('input', () => {
  const next = moeda(valor.value);
  if (next !== valor.value) valor.value = next;
});

async function carregar() {
  const eu = await contaApi('/api/conta/eu');
  document.getElementById('ola').textContent = `Olá, ${eu.nome}`;
  document.getElementById('nome').value = eu.nome;
  document.getElementById('email').value = eu.email;
  document.getElementById('usuario').value = eu.usuario;
}

document.getElementById('dados').addEventListener('submit', async (event) => {
  event.preventDefault();
  const erro = document.getElementById('dados-erro');
  const ok = document.getElementById('dados-msg');
  erro.textContent = '';
  ok.textContent = '';
  const senha = document.getElementById('senha').value;
  const body = {
    nome: document.getElementById('nome').value.trim(),
    email: document.getElementById('email').value.trim(),
    usuario: document.getElementById('usuario').value.trim(),
  };
  if (senha) body.senha = senha;
  try {
    const eu = await contaApi('/api/conta/eu', { method: 'PATCH', body: JSON.stringify(body) });
    document.getElementById('ola').textContent = `Olá, ${eu.nome}`;
    document.getElementById('senha').value = '';
    ok.textContent = 'Dados atualizados.';
  } catch (err) {
    erro.textContent = err.message || 'Erro no servidor';
  }
});

document.getElementById('cobranca').addEventListener('submit', async (event) => {
  event.preventDefault();
  const erro = document.getElementById('cobranca-erro');
  erro.textContent = '';
  try {
    const data = await contaApi('/api/conta/cobranca', {
      method: 'POST',
      body: JSON.stringify({ valor: valor.value.trim() }),
    });
    window.location.assign(data.rampUrl);
  } catch (err) {
    erro.textContent = err.message || 'Erro no servidor';
  }
});

document.getElementById('abrir-excluir').addEventListener('click', () => {
  document.getElementById('excluir-erro').textContent = '';
  modal.classList.add('show');
});
document.getElementById('cancelar').addEventListener('click', () => modal.classList.remove('show'));

document.getElementById('confirmar').addEventListener('click', async () => {
  const erro = document.getElementById('excluir-erro');
  erro.textContent = '';
  try {
    await contaApi('/api/conta/eu', { method: 'DELETE' });
    setConta('');
    window.location.replace('/index.html');
  } catch (err) {
    erro.textContent = err.message || 'Erro no servidor';
  }
});

document.getElementById('sair').addEventListener('click', async () => {
  try {
    await contaApi('/api/conta/sair', { method: 'POST' });
  } catch {
    /* a sessão local sai de qualquer forma */
  }
  setConta('');
  window.location.replace('/index.html');
});

carregar().catch((err) => {
  if (err.status === 401) {
    setConta('');
    window.location.replace('/index.html');
    return;
  }
  document.getElementById('ola').textContent = err.message || 'Erro no servidor';
});
