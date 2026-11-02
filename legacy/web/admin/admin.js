const $ = (id) => document.getElementById(id);
const state = { token: sessionStorage.getItem('motor.admin.token') || '' };

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.erro || `HTTP ${response.status}`);
  return data;
}

function showLogin() {
  $('login').hidden = false;
  $('painel').hidden = true;
  $('sair').hidden = true;
}

function showPanel() {
  $('login').hidden = true;
  $('painel').hidden = false;
  $('sair').hidden = false;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.token = $('admin-token').value.trim();
  $('login-erro').textContent = '';
  try {
    await api('/admin/api/status');
    sessionStorage.setItem('motor.admin.token', state.token);
    showPanel();
    await refresh();
  } catch (err) {
    $('login-erro').textContent = err.message;
  }
});

$('sair').addEventListener('click', () => {
  sessionStorage.removeItem('motor.admin.token');
  state.token = '';
  showLogin();
});

$('cliente-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    nome: $('cliente-nome').value.trim(),
    webhook_url: $('cliente-webhook').value.trim(),
  };
  try {
    const data = await api('/admin/api/clientes', { method: 'POST', body: JSON.stringify(body) });
    $('credenciais').hidden = false;
    $('credenciais').textContent = [
      `api_key=${data.api_key}`,
      `request_secret=${data.request_secret}`,
      `webhook_secret=${data.webhook_secret}`,
      '',
      'Guarde estes valores agora: eles nao serao mostrados de novo.',
    ].join('\n');
    $('cliente-form').reset();
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

async function refresh() {
  try {
    const [status, clientes, perfis, links, webhooks, alertas] = await Promise.all([
      api('/admin/api/status'),
      api('/admin/api/clientes'),
      api('/admin/api/ramp-profiles'),
      api('/admin/api/links?limit=25'),
      api('/admin/api/webhooks?limit=25'),
      api('/admin/api/alerts'),
    ]);
    renderStatus(status.data);
    renderClientes(clientes.data);
    renderPerfis(perfis.data);
    renderLinks(links.data);
    renderWebhooks(webhooks.data);
    renderAlertas(alertas.data);
  } catch (err) {
    if (String(err.message).includes('token')) showLogin();
  }
}

function renderStatus(data) {
  const rows = [
    ['Clientes', data.clientes],
    ['Perfis Ramp', data.perfis_ramp],
    ['Links recentes', data.links_recentes],
    ['Webhooks recentes', data.webhooks_recentes],
  ];
  $('status').innerHTML = rows.map(([k, v]) => `<span>${esc(k)}</span><strong>${esc(v)}</strong>`).join('');
}

function renderAlertas(items) {
  $('alertas').innerHTML = items.length
    ? items.map((a) => `<li><strong>${esc(a.titulo)}</strong><br><span class="muted">${esc(a.descricao)}</span></li>`).join('')
    : '<li class="muted">Nenhum alerta.</li>';
}

function renderClientes(items) {
  $('clientes').innerHTML = table(
    ['Nome', 'Prefixo', 'Status', 'Webhook', 'Acoes'],
    items.map((c) => [
      esc(c.nome),
      `<code>${esc(c.api_key_prefix)}</code>`,
      `<span class="badge ${esc(c.status)}">${esc(c.status)}</span>`,
      esc(c.webhook_url),
      `<div class="acoes"><button class="ghost" data-rotate="${esc(c.id)}">Rotacionar chave</button><button class="ghost" data-wallet="${esc(c.id)}">Carteira</button></div>`,
    ]),
  );
}

function renderPerfis(items) {
  $('perfis').innerHTML = table(
    ['Label', 'Chain', 'Asset', 'Contrato', 'Taxa'],
    items.map((p) => [
      esc(p.label),
      esc(p.chain),
      esc(p.asset),
      `<code>${esc(p.token_contract)}</code>`,
      esc(p.taxa_token_por_fiat_base_units ?? '-'),
    ]),
  );
}

function renderLinks(items) {
  $('links').innerHTML = table(
    ['ID', 'Cliente', 'External', 'Valor', 'Status', 'Recebido', 'Criado', 'Acoes'],
    items.map((l) => [
      `<code>${esc(l.id.slice(0, 8))}</code>`,
      `<code>${esc(l.id.slice(0, 8))}</code>`,
      esc(l.external_id),
      esc((l.valor_fiat_centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: l.moeda_fiat })),
      `<span class="badge ${esc(l.status)}">${esc(l.status)}</span>`,
      esc(l.valor_recebido_base_units),
      esc(new Date(l.criado_em).toLocaleString('pt-BR')),
      `<button class="ghost" data-revoke="${esc(l.id)}">Revogar</button>`,
    ]),
  );
}

function renderWebhooks(items) {
  $('webhooks').innerHTML = table(
    ['Evento', 'Status', 'Tentativas', 'Proxima', 'Erro', 'Acoes'],
    items.map((w) => [
      esc(w.event_type),
      `<span class="badge ${esc(w.status)}">${esc(w.status)}</span>`,
      esc(w.attempts),
      esc(new Date(w.next_attempt_em).toLocaleString('pt-BR')),
      esc(w.last_error ?? '-'),
      `<button class="ghost" data-replay="${esc(w.id)}">Reenviar</button>`,
    ]),
  );
}

function table(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const rotate = target.getAttribute('data-rotate');
  const wallet = target.getAttribute('data-wallet');
  const revoke = target.getAttribute('data-revoke');
  const replay = target.getAttribute('data-replay');
  try {
    if (rotate) {
      if (!confirm('Rotacionar a API key e o request secret deste cliente?')) return;
      const data = await api(`/admin/api/clientes/${rotate}/rotate-key`, { method: 'POST' });
      $('credenciais').hidden = false;
      $('credenciais').textContent = `api_key=${data.api_key}\nrequest_secret=${data.request_secret}\n\nGuarde agora.`;
      await refresh();
    } else if (wallet) {
      const label = prompt('Label da carteira:');
      if (!label) return;
      const chain = prompt('Chain (ex.: polygon):', 'polygon');
      if (!chain) return;
      const address = prompt('Endereco EVM (0x...):');
      if (!address) return;
      await api(`/admin/api/clientes/${wallet}/wallets`, {
        method: 'POST',
        body: JSON.stringify({ label, chain, address }),
      });
      await refresh();
    } else if (revoke) {
      if (!confirm('Revogar este link?')) return;
      await api(`/admin/api/links/${revoke}/revoke`, { method: 'POST' });
      await refresh();
    } else if (replay) {
      await api(`/admin/api/webhooks/${replay}/replay`, { method: 'POST' });
      await refresh();
    }
  } catch (err) {
    alert(err.message);
  }
});

if (state.token) {
  api('/admin/api/status').then(async () => {
    showPanel();
    await refresh();
  }).catch(showLogin);
} else {
  showLogin();
}
