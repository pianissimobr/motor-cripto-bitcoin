// Card "Mercado": grafico de 7 dias da moeda escolhida + blocos com as outras.
// So ilustrativo: nenhum valor daqui entra em cobranca.

const SVG = 'http://www.w3.org/2000/svg';
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCompact = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit' });
const tipFmt = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const hourFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function node(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
}

function money(v) {
  // Moedas abaixo de R$ 10 (USDC) precisam de mais casas para mostrar variacao.
  return v < 10
    ? new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      }).format(v)
    : brl.format(v);
}

function delta(change) {
  const span = document.createElement('span');
  if (change === null || change === undefined) {
    span.className = 'muted';
    span.textContent = '—';
    return span;
  }
  const up = change >= 0;
  span.className = `delta ${up ? 'up' : 'down'}`;
  span.textContent = `${up ? '▲' : '▼'} ${pct.format(Math.abs(change))}% em 24h`;
  return span;
}

function timeAt(coin, i) {
  const from = Date.parse(coin.from);
  const to = Date.parse(coin.to);
  return new Date(from + ((to - from) * i) / (coin.points.length - 1));
}

/** Escala "bonita" para o eixo Y: 3 a 4 linhas de grade. */
function niceTicks(min, max) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { lo, hi, ticks };
}

function drawHero(container, coin) {
  container.innerHTML = '';
  // Desenha na largura real do card: texto do eixo legivel no celular.
  const W = Math.max(280, Math.round(container.clientWidth || 640));
  const narrow = W < 520;
  const H = narrow ? 200 : 300;
  const pad = { top: 12, right: 12, bottom: 26, left: narrow ? 64 : 72 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;
  const pts = coin.points;
  const { lo, hi, ticks } = niceTicks(Math.min(...pts), Math.max(...pts));
  const x = (i) => pad.left + (iw * i) / (pts.length - 1);
  const y = (v) => pad.top + ih - (ih * (v - lo)) / (hi - lo || 1);

  const svg = node('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'mk-svg',
    role: 'img',
    'aria-label': `${coin.name} nos últimos 7 dias, de ${money(pts[0])} a ${money(pts.at(-1))}`,
  });
  const defs = node('defs', {}, svg);
  const grad = node('linearGradient', { id: 'mk-fill', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  node('stop', { offset: '0%', class: 'mk-stop-top' }, grad);
  node('stop', { offset: '100%', class: 'mk-stop-bottom' }, grad);

  for (const t of ticks) {
    node('line', { x1: pad.left, x2: W - pad.right, y1: y(t), y2: y(t), class: 'mk-grid' }, svg);
    const label = node('text', { x: pad.left - 8, y: y(t) + 4, class: 'mk-axis', 'text-anchor': 'end' }, svg);
    label.textContent = brlCompact.format(t);
  }
  // Um rotulo por dia no eixo X.
  const days = 7;
  for (let d = 0; d <= days; d += 1) {
    const i = Math.round(((pts.length - 1) * d) / days);
    if (d === 0 || d === days || (narrow && d % 2 === 1)) continue;
    const label = node('text', { x: x(i), y: H - 8, class: 'mk-axis', 'text-anchor': 'middle' }, svg);
    label.textContent = dayFmt.format(timeAt(coin, i));
  }

  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  node('path', { d: `${line}L${x(pts.length - 1)},${pad.top + ih}L${x(0)},${pad.top + ih}Z`, fill: 'url(#mk-fill)' }, svg);
  node('path', { d: line, class: 'mk-line' }, svg);
  const last = node('circle', { cx: x(pts.length - 1), cy: y(pts.at(-1)), r: 4, class: 'mk-dot' }, svg);

  // Camada de hover: linha vertical + ponto + tooltip.
  const cross = node('line', { y1: pad.top, y2: pad.top + ih, class: 'mk-cross hidden' }, svg);
  const hoverDot = node('circle', { r: 5, class: 'mk-dot hidden' }, svg);
  const hit = node('rect', { x: pad.left, y: pad.top, width: iw, height: ih, fill: 'transparent' }, svg);
  const tip = document.createElement('div');
  tip.className = 'mk-tip hidden';

  function show(evt) {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - pad.left) / iw) * (pts.length - 1))));
    const cx = x(i);
    const cy = y(pts[i]);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    hoverDot.setAttribute('cx', cx);
    hoverDot.setAttribute('cy', cy);
    cross.classList.remove('hidden');
    hoverDot.classList.remove('hidden');
    last.classList.add('hidden');
    tip.innerHTML = '';
    const v = document.createElement('strong');
    v.textContent = money(pts[i]);
    const t = document.createElement('div');
    t.className = 'muted';
    t.textContent = tipFmt.format(timeAt(coin, i));
    tip.append(v, t);
    tip.classList.remove('hidden');
    const left = (cx / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
    tip.style.top = `${(cy / H) * box.height}px`;
  }
  function hide() {
    cross.classList.add('hidden');
    hoverDot.classList.add('hidden');
    last.classList.remove('hidden');
    tip.classList.add('hidden');
  }
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);

  container.append(svg, tip);
}

function sparkline(coin) {
  const W = 120;
  const H = 32;
  const pts = coin.points;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const x = (i) => 2 + ((W - 4) * i) / (pts.length - 1);
  const y = (v) => 3 + (H - 6) * (1 - (v - min) / (max - min || 1));
  const svg = node('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mk-spark', 'aria-hidden': 'true' });
  node('path', { d: pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''), class: 'mk-spark-line' }, svg);
  node('circle', { cx: x(pts.length - 1), cy: y(pts.at(-1)), r: 3, class: 'mk-dot' }, svg);
  return svg;
}

export async function loadMarket() {
  const card = document.getElementById('market-card');
  if (!card) return;
  let data;
  try {
    const res = await fetch('/v1/portal/market');
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    document.getElementById('mk-note').textContent = 'Mercado indisponível agora.';
    return;
  }
  const coins = data.coins ?? [];
  if (coins.length === 0) return;
  let selected = card.dataset.selected && coins.some((c) => c.id === card.dataset.selected)
    ? card.dataset.selected
    : coins[0].id;

  const head = document.getElementById('mk-head');
  const chart = document.getElementById('mk-chart');
  const tiles = document.getElementById('mk-tiles');

  let resizeTimer;
  window.onresize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const coin = coins.find((c) => c.id === selected);
      if (coin) drawHero(chart, coin);
    }, 150);
  };

  function render() {
    card.dataset.selected = selected;
    const coin = coins.find((c) => c.id === selected);
    head.innerHTML = '';
    const name = document.createElement('div');
    name.className = 'mk-name';
    name.textContent = `${coin.name} (${coin.symbol})`;
    const price = document.createElement('div');
    price.className = 'mk-price';
    price.textContent = money(coin.price_brl);
    head.append(name, price, delta(coin.change_24h_pct));
    drawHero(chart, coin);

    tiles.innerHTML = '';
    for (const c of coins) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `mk-tile${c.id === selected ? ' active' : ''}`;
      b.setAttribute('aria-pressed', String(c.id === selected));
      const top = document.createElement('div');
      top.className = 'mk-tile-top';
      const sym = document.createElement('strong');
      sym.textContent = c.symbol;
      const val = document.createElement('span');
      val.textContent = money(c.price_brl);
      top.append(sym, val);
      b.append(top, sparkline(c), delta(c.change_24h_pct));
      b.addEventListener('click', () => {
        selected = c.id;
        render();
      });
      tiles.appendChild(b);
    }
  }
  render();
  document.getElementById('mk-note').textContent =
    `Preços em R$ · fonte CoinGecko · atualizado às ${hourFmt.format(new Date(data.updated_at))}. ` +
    'Só ilustrativo: a cobrança usa a cotação travada no momento de gerar o QR.';
}
