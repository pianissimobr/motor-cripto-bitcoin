// Pagina publica da fatura (/i/:id). Arquivo proprio: o CSP bloqueia script inline.
(function () {
  const root = document.getElementById('invoice');
  const app = document.getElementById('app');
  const id = root.dataset.id;
  const base = '/i/' + id;
  let state = null;
  let tab = null;
  let busy = false;
  let error = null;
  let redirected = false;

  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'onclick' || k === 'onsubmit') node[k] = v;
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  const svgImg = (svg, alt) => el('img', { class: 'qr', alt, src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg) });

  const copyRow = (value, label) => {
    const button = el('button', { type: 'button' }, label || 'Copiar');
    button.onclick = () => navigator.clipboard.writeText(value).then(() => {
      button.textContent = 'Copiado';
      setTimeout(() => (button.textContent = label || 'Copiar'), 1500);
    });
    return el('div', { class: 'copy' }, el('code', {}, value), button);
  };

  async function call(path, body) {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error && data.error.message) || 'Erro ' + res.status);
    return data;
  }

  function remaining() {
    const ms = new Date(state.expires_at).getTime() - Date.now();
    if (ms <= 0) return null;
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return m + ':' + String(s).padStart(2, '0');
  }

  function render() {
    app.replaceChildren();
    if (!state) return;
    if (error) app.append(el('div', { class: 'error', role: 'alert' }, error));

    if (state.status === 'pago') {
      app.append(el('div', { class: 'state' }, el('div', { class: 'big ok' }, 'Pagamento confirmado'), el('div', { class: 'muted' }, 'Obrigado! Você já pode fechar esta página.')));
      if (state.success_url) {
        app.append(el('p', { class: 'hint' }, 'Voltando para a loja…'));
        if (!redirected) {
          redirected = true;
          setTimeout(() => window.location.assign(state.success_url), 2500);
        }
      }
      return;
    }
    if (state.status === 'confirmando') {
      app.append(el('div', { class: 'state' }, el('div', { class: 'big' }, 'Pagamento recebido'), el('div', { class: 'muted' }, 'Estamos confirmando na rede. Isso leva alguns minutos; pode fechar esta página.')));
      return;
    }
    if (state.status !== 'aguardando') {
      app.append(el('div', { class: 'state' }, el('div', { class: 'big bad' }, 'Fatura expirada'), el('div', { class: 'muted' }, 'Volte à loja e gere um novo pagamento.')));
      if (state.cancel_url) app.append(el('a', { href: state.cancel_url }, el('button', { class: 'btn btn-ghost', type: 'button' }, 'Voltar para a loja')));
      return;
    }

    const left = remaining();
    if (left) app.append(el('div', { class: 'timer', id: 'timer' }, 'Expira em ' + left));

    const rails = state.rails;
    if (!tab) tab = (state.payments[0] && state.payments[0].rail) || rails[0];
    if (rails.length > 1) {
      app.append(el('div', { class: 'tabs', role: 'tablist' }, rails.map((r) => {
        const b = el('button', { type: 'button', class: r === tab ? 'active' : '' }, r === 'pix' ? 'Pix' : 'Bitcoin');
        b.onclick = () => { tab = r; error = null; render(); };
        return b;
      })));
    }

    const payment = state.payments.find((p) => p.rail === tab);
    if (payment && payment.rail === 'pix') {
      app.append(svgImg(payment.qr_svg, 'QR Code Pix'), copyRow(payment.qr_copypaste, 'Copiar Pix'), el('p', { class: 'hint' }, 'Abra o app do seu banco, escolha Pix e leia o QR ou cole o código.'));
    } else if (payment && payment.rail === 'bitcoin') {
      app.append(
        svgImg(payment.qr_svg, 'QR Code Bitcoin'),
        el('p', { class: 'hint' }, 'Envie exatamente ' + payment.amount_btc + ' BTC para:'),
        copyRow(payment.address, 'Copiar'),
        el('p', { class: 'hint' }, 'A confirmação pode levar de 10 a 30 minutos.'),
      );
    } else if (tab === 'pix') {
      const input = el('input', { id: 'tax', inputmode: 'numeric', autocomplete: 'off', placeholder: '000.000.000-00', required: true, maxlength: 18 });
      const form = el('form', {}, el('label', { for: 'tax' }, 'CPF ou CNPJ de quem vai pagar'), input, el('button', { class: 'btn', disabled: busy }, busy ? 'Gerando…' : 'Gerar Pix'));
      form.onsubmit = (e) => { e.preventDefault(); choose('/pix', { payer_tax_number: input.value }); };
      app.append(form, el('p', { class: 'hint' }, 'O CPF é exigido pelo Pix para identificar o pagador.'));
    } else {
      const b = el('button', { class: 'btn', type: 'button', disabled: busy }, busy ? 'Gerando…' : 'Pagar com Bitcoin');
      b.onclick = () => choose('/bitcoin', {});
      app.append(el('p', { class: 'muted' }, 'Geramos um endereço Bitcoin com o valor exato. O valor é convertido e entregue à loja.'), b);
    }

    if (state.mode === 'test' && payment) {
      const sim = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Simular pagamento (teste)');
      sim.onclick = async () => {
        try { await call('/simulate', {}); await refresh(); } catch (e) { error = e.message; render(); }
      };
      app.append(sim);
    }
  }

  async function choose(path, body) {
    busy = true; error = null; render();
    try {
      await call(path, body);
      await refresh();
    } catch (e) {
      error = e.message.charAt(0).toUpperCase() + e.message.slice(1);
    } finally {
      busy = false; render();
    }
  }

  async function refresh() {
    try {
      const next = await call('/state');
      // So redesenha se algo mudou: o poll nao apaga o CPF sendo digitado.
      const changed = JSON.stringify(next) !== JSON.stringify(state);
      state = next;
      if (changed) render();
    } catch (e) {
      if (!state) { error = e.message; render(); }
    }
  }

  refresh();
  setInterval(() => { if (state && (state.status === 'aguardando' || state.status === 'confirmando')) refresh(); }, 5000);
  setInterval(() => {
    const timer = document.getElementById('timer');
    if (!timer || !state) return;
    const left = remaining();
    if (left) timer.textContent = 'Expira em ' + left;
    else refresh();
  }, 1000);
})();
