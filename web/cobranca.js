import {
  api,
  baseUnitsToDecimal,
  escapeHtml,
  fmtBRL,
  fmtDate,
  maskEmail,
  setupAuth,
  statusBadge,
  toast,
} from '/app.js';

setupAuth();

const el = (id) => document.getElementById(id);

let clienteSelecionado = null;
let perfilSelecionado = null;
let carteiras = [];
let linkAtual = null;
let pollTimer = null;

/* ------------------------------------------------------------------ */
/* Carga inicial                                                       */
/* ------------------------------------------------------------------ */

async function carregarReferencias() {
  try {
    const [perfis, carteirasResp] = await Promise.all([
      api('/api/ramp-profiles'),
      api('/api/carteiras-frias'),
    ]);

    const selectRamp = el('rampId');
    selectRamp.innerHTML = perfis.perfis
      .map(
        (p) =>
          `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)} - ` +
          `${escapeHtml(p.chain)} / ${escapeHtml(p.asset)} / ${escapeHtml(p.fiatCurrency)}</option>`,
      )
      .join('');
    if (perfis.perfis.length) {
      selectRamp.value = perfis.perfis[0].id;
      perfilSelecionado = perfis.perfis[0];
    }

    carteiras = carteirasResp.carteiras || [];
    const selectCarteira = el('carteiraId');
    selectCarteira.innerHTML =
      '<option value="">-- usar a carteira informada abaixo --</option>' +
      carteiras
        .map(
          (c) =>
            `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)} ` +
            `(${escapeHtml(c.chain)}) ${escapeHtml(c.address.slice(0, 10))}...` +
            `${escapeHtml(c.address.slice(-6))}</option>`,
        )
        .join('');
  } catch (err) {
    if (err.status !== 401 && err.status !== 403) toast(err.message, 'err');
  }
}

el('rampId').addEventListener('change', async () => {
  try {
    const data = await api('/api/ramp-profiles');
    perfilSelecionado = data.perfis.find((p) => p.id === el('rampId').value) || null;
  } catch {
    perfilSelecionado = null;
  }
});

/* ------------------------------------------------------------------ */
/* Busca de cliente                                                    */
/* ------------------------------------------------------------------ */

const sugestoes = el('sugestoes');
const emailInput = el('email');

emailInput.addEventListener('input', async () => {
  const valor = emailInput.value.trim().toLowerCase();
  clienteSelecionado = null;
  el('clienteSelecionado').textContent = 'Nenhum cliente selecionado.';
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
  sugestoes.innerHTML = clientes
    .map(
      (c) =>
        `<li data-id="${escapeHtml(c.id)}" data-email="${escapeHtml(c.email)}">` +
        `<strong>${escapeHtml(c.nome)}</strong>` +
        `<span class="m"> &nbsp;${escapeHtml(c.emailMasked || maskEmail(c.email))}</span></li>`,
    )
    .join('');
  sugestoes.classList.add('show');
  sugestoes.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      clienteSelecionado = { id: li.dataset.id, email: li.dataset.email };
      emailInput.value = li.dataset.email;
      sugestoes.classList.remove('show');
      el('clienteSelecionado').textContent = `Cliente: ${li.dataset.email}`;
      el('clienteSelecionado').className = 'ok-msg';
    });
  });
}

/* ------------------------------------------------------------------ */
/* Geracao do link                                                     */
/* ------------------------------------------------------------------ */

el('gerar').addEventListener('click', async () => {
  const errorBox = el('error');
  errorBox.textContent = '';

  const email = emailInput.value.trim();
  if (!email) {
    errorBox.textContent = 'Informe o email do cliente.';
    return;
  }

  const valorTexto = el('valor').value.trim();
  if (!valorTexto) {
    errorBox.textContent = 'Informe o valor da cobranca.';
    return;
  }

  const rampProfileId = el('rampId').value;
  if (!rampProfileId) {
    errorBox.textContent = 'Cadastre um perfil de integracao Ramp.';
    return;
  }

  const coldWalletId = el('carteiraId').value || null;
  const coldWalletAddress = coldWalletId ? null : el('carteiraEndereco').value.trim() || null;
  if (!coldWalletId && !coldWalletAddress) {
    errorBox.textContent = 'Selecione a carteira final ou informe o endereco 0x...';
    return;
  }

  const button = el('gerar');
  button.disabled = true;
  button.textContent = 'Gerando...';
  try {
    const body = { valor: valorTexto, rampProfileId, coldWalletId, coldWalletAddress };
    if (email) body.email = email;

    const link = await api('/api/links', { method: 'POST', body: JSON.stringify(body) });
    linkAtual = link;
    renderResultado(link);
    el('statusCard').style.display = 'block';
    iniciarPolling(link.id);
    await carregarLinks();
    toast('Link de cobranca gerado', 'ok');
  } catch (err) {
    errorBox.textContent = err.message;
    toast(err.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Gerar link de pagamento';
  }
});

function renderResultado(link) {
  el('resultCard').style.display = 'block';
  const perfil = perfilSelecionado;
  const taxa = perfil && perfil.taxaTokenPorFiatBaseUnits
    ? baseUnitsToDecimal(perfil.taxaTokenPorFiatBaseUnits, perfil.decimals)
    : null;

  el('resultado').innerHTML = `
    <div class="field">
      <div class="k">Link de pagamento (Ramp)</div>
      <div class="link-out" id="rampUrl">${escapeHtml(link.rampUrl)}</div>
      <div class="row" style="margin-top:10px">
        <button class="small" id="copiar">Copiar link</button>
        <a class="small" href="${escapeHtml(link.rampUrl)}" target="_blank" rel="noopener noreferrer">
          <button class="small ghost" type="button">Abrir checkout</button>
        </a>
      </div>
    </div>
    <div class="field">
      <div class="k">Endereco de deposito (derivado, exclusivo deste link)</div>
      <div class="v">${escapeHtml(link.enderecoDeposito)}</div>
    </div>
    <div class="field">
      <div class="k">Valor</div>
      <div class="v">${escapeHtml(link.valor)} ${escapeHtml(link.moeda)} ${taxa ? `~ ${escapeHtml(taxa)} ${escapeHtml(link.asset)} por 1,00` : ''}</div>
    </div>
    <div class="field">
      <div class="k">ID do link</div>
      <div class="v">${escapeHtml(link.id)}</div>
    </div>
    <div class="field">
      <div class="k">Expira em</div>
      <div class="v">${escapeHtml(fmtDate(link.expiraEm))}</div>
    </div>
    <div class="hint">
      Envie este link ao cliente. O pagamento cai no endereco derivado; o motor
      confirma on-chain e envia o valor para a carteira fria.
    </div>`;

  el('copiar').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link.rampUrl);
      toast('Link copiado', 'ok');
    } catch {
      toast('Nao foi possivel copiar: selecione o texto manualmente', 'err');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Status + polling                                                    */
/* ------------------------------------------------------------------ */

function iniciarPolling(linkId) {
  if (pollTimer) clearInterval(pollTimer);
  const tick = async () => {
    try {
      const data = await api(`/api/links/${encodeURIComponent(linkId)}`);
      renderStatus(data);
      if (['movido'].includes(data.status)) {
        clearInterval(pollTimer);
        pollTimer = null;
        carregarLinks();
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
  };
  pollTimer = setInterval(tick, 8000);
  tick();
}

function renderStatus(data) {
  const pagamentos = (data.pagamentos || [])
    .map(
      (p) =>
        `<tr><td class="mono">${escapeHtml(p.txHash.slice(0, 18))}...</td>` +
        `<td class="mono">${escapeHtml(p.valor)}</td>` +
        `<td>${escapeHtml(p.confirmacoes)}</td>` +
        `<td>${escapeHtml(p.status)}</td></tr>`,
    )
    .join('');

  const movimentos = (data.movimentos || [])
    .map(
      (m) =>
        `<tr><td class="mono">${m.txHash ? escapeHtml(m.txHash.slice(0, 18)) + '...' : '-'}</td>` +
        `<td>${escapeHtml(m.status)}</td>` +
        `<td class="mono">${escapeHtml(m.erro || '')}</td></tr>`,
    )
    .join('');

  const creditos = (data.creditos || [])
    .map(
      (c) =>
        `<tr><td class="mono">${escapeHtml(c.valor)}</td>` +
        `<td>${escapeHtml(c.valorFiat || c.valorCentavos || '-')}</td>` +
        `<td>${escapeHtml(c.status)}</td></tr>`,
    )
    .join('');

  el('statusBox').innerHTML = `
    <div class="field">
      <div class="k">Status do link</div>
      <div class="v">${statusBadge(data.status)}</div>
    </div>
    <div class="field">
      <div class="k">Pagamentos detectados</div>
      <div class="v">${
        pagamentos
          ? `<table><thead><tr><th>Tx</th><th>Valor (base units)</th><th>Conf.</th><th>Status</th></tr></thead><tbody>${pagamentos}</tbody></table>`
          : '<span class="hint">nenhum pagamento detectado ainda</span>'
      }</div>
    </div>
    <div class="field">
      <div class="k">Credito do cliente</div>
      <div class="v">${
        creditos
          ? `<table><thead><tr><th>Valor (base units)</th><th>Equivalente</th><th>Status</th></tr></thead><tbody>${creditos}</tbody></table>`
          : '<span class="hint">sem credito liberado</span>'
      }</div>
    </div>
    <div class="field">
      <div class="k">Transferencia para a carteira fria</div>
      <div class="v">${
        movimentos
          ? `<table><thead><tr><th>Tx</th><th>Status</th><th>Observacao</th></tr></thead><tbody>${movimentos}</tbody></table>`
          : '<span class="hint">ainda nao executada</span>'
      }</div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Lista de links recentes                                             */
/* ------------------------------------------------------------------ */

async function carregarLinks() {
  try {
    const data = await api('/api/links?limit=20');
    const linhas = (data.links || [])
      .map(
        (l) =>
          `<tr data-id="${escapeHtml(l.id)}" style="cursor:pointer">` +
          `<td class="mono">${escapeHtml(l.id.slice(0, 8))}</td>` +
          `<td>${escapeHtml(l.valor)}</td>` +
          `<td>${escapeHtml(l.asset)}</td>` +
          `<td>${statusBadge(l.status)}</td>` +
          `<td class="mono">${escapeHtml(fmtDate(l.criadoEm))}</td></tr>`,
      )
      .join('');
    el('lista').innerHTML = linhas
      ? `<table><thead><tr><th>ID</th><th>Valor</th><th>Asset</th><th>Status</th><th>Criado</th></tr></thead><tbody>${linhas}</tbody></table>`
      : '<div class="hint">Nenhum link gerado ainda.</div>';

    el('lista').querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => {
        linkAtual = tr.dataset.id;
        el('statusCard').style.display = 'block';
        iniciarPolling(tr.dataset.id);
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      });
    });
  } catch (err) {
    if (err.status !== 401 && err.status !== 403) toast(err.message, 'err');
  }
}

carregarReferencias();
carregarLinks();
