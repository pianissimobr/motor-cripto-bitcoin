import { api, escapeHtml, fmtDate, maskEmail, setupAuth, toast } from '/app.js';

setupAuth();

const el = (id) => document.getElementById(id);

const nomeInput = el('nome');
const emailInput = el('email');
const buscaInput = el('busca');
const sugestoes = el('sugestoes');
const resultado = el('resultado');

/* ------------------------------------------------------------------ */
/* Cadastro                                                            */
/* ------------------------------------------------------------------ */

el('submit').addEventListener('click', async () => {
  const errorBox = el('error');
  const okBox = el('ok');
  errorBox.textContent = '';
  okBox.textContent = '';

  const nome = nomeInput.value.trim();
  const email = emailInput.value.trim();

  if (nome.length < 2) {
    errorBox.textContent = 'Informe o nome completo.';
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errorBox.textContent = 'Informe um email valido.';
    return;
  }

  const button = el('submit');
  button.disabled = true;
  button.textContent = 'Cadastrando...';
  try {
    const created = await api('/api/cadastros', {
      method: 'POST',
      body: JSON.stringify({ nome, email }),
    });
    okBox.textContent = `Cadastro criado (${created.emailMasked}).`;
    toast('Cliente cadastrado', 'ok');
    nomeInput.value = '';
    emailInput.value = '';
    await consultar(email);
  } catch (err) {
    errorBox.textContent = err.message;
    toast(err.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Cadastrar';
  }
});

/* ------------------------------------------------------------------ */
/* Busca                                                               */
/* ------------------------------------------------------------------ */

el('buscar').addEventListener('click', () => {
  const valor = buscaInput.value.trim();
  if (valor.length < 3) {
    toast('Digite ao menos 3 caracteres', 'err');
    return;
  }
  consultar(valor);
});

buscaInput.addEventListener('input', async () => {
  const valor = buscaInput.value.trim().toLowerCase();
  if (valor.length < 3) {
    sugestoes.classList.remove('show');
    return;
  }
  try {
    const data = await api(`/api/cadastros?q=${encodeURIComponent(valor)}&limit=8`);
    renderSugestoes(data.clientes || []);
  } catch (err) {
    if (err.status !== 401 && err.status !== 403) toast(err.message, 'err');
  }
});

function renderSugestoes(clientes) {
  if (!clientes.length) {
    sugestoes.classList.remove('show');
    return;
  }
  // PII mascarada por padrao: o email completo so vem no clique (auditado).
  sugestoes.innerHTML = clientes
    .map(
      (c) =>
        `<li data-id="${escapeHtml(c.id)}"><strong>${escapeHtml(c.nome)}</strong>` +
        `<span class="m"> &nbsp;${escapeHtml(c.emailMasked || '')}</span></li>`,
    )
    .join('');
  sugestoes.classList.add('show');
  sugestoes.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', async () => {
      sugestoes.classList.remove('show');
      try {
        const full = await api(
          `/api/cadastros/${encodeURIComponent(li.dataset.id)}?reveal=true`,
        );
        buscaInput.value = full.email;
        consultar(full.email);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });
}

async function consultar(valor) {
  resultado.innerHTML = '';
  try {
    const data = await api(`/api/cadastros?email=${encodeURIComponent(valor)}&reveal=true`);
    const clientes = data.clientes || [];
    if (!clientes.length) {
      resultado.innerHTML = '<div class="hint">Nenhum cadastro encontrado.</div>';
      return;
    }
    const c = clientes[0];
    const links = await api(`/api/links?clienteId=${encodeURIComponent(c.id)}`);
    const creditos = await api(`/api/creditos?clienteId=${encodeURIComponent(c.id)}`);

    resultado.innerHTML = `
      <div class="field">
        <div class="k">Cliente</div>
        <div class="v">${escapeHtml(c.nome)}</div>
      </div>
      <div class="field">
        <div class="k">Email</div>
        <div class="v">${escapeHtml(c.emailMasked || maskEmail(c.email))}</div>
      </div>
      <div class="field">
        <div class="k">Credito total</div>
        <div class="v">${escapeHtml(creditos.total || 'R$ 0,00')} (${creditos.totalCentavos || 0} centavos)</div>
      </div>
      <div class="field">
        <div class="k">Cadastrado em</div>
        <div class="v">${escapeHtml(fmtDate(c.criadoEm))}</div>
      </div>
      <div class="field">
        <div class="k">Links (${links.links.length})</div>
        <div class="v">${links.links.length ? renderLinks(links.links) : '<span class="hint">nenhum link gerado</span>'}</div>
      </div>`;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      resultado.innerHTML = '<div class="hint">Token invalido ou ausente.</div>';
      return;
    }
    resultado.innerHTML = `<div class="hint">${escapeHtml(err.message)}</div>`;
  }
}

function renderLinks(links) {
  const rows = links
    .slice(0, 10)
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.valor)}</td><td>${escapeHtml(l.asset)}</td>` +
        `<td><span class="badge ${escapeHtml(l.status)}">${escapeHtml(l.status)}</span></td>` +
        `<td class="mono">${escapeHtml(fmtDate(l.criadoEm))}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Valor</th><th>Asset</th><th>Status</th><th>Criado</th></tr></thead><tbody>${rows}</tbody></table>`;
}
