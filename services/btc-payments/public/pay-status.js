// Atualiza o status da pagina publica /pay/:id. Fica em arquivo proprio
// porque o CSP (script-src 'self') bloqueia script inline.
async function poll() {
  try {
    const res = await fetch(window.location.pathname.replace(/\/$/, '') + '/status');
    if (!res.ok) return;
    const data = await res.json();
    const node = document.getElementById('status');
    if (node && data.status) node.textContent = data.status;
    if (data.paid) window.location.reload();
  } catch {
    // rede instavel: tenta de novo no proximo ciclo
  }
}
setInterval(poll, 5000);
