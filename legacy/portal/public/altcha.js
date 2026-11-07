// Anti-robo (ALTCHA) sem biblioteca externa: busca o desafio no motor
// (/auth/altcha, que repassa o do authO) e acha o numero cujo SHA-256 bate.
// Devolve o payload em base64 para mandar como `altcha`, ou null quando o
// anti-robo esta desligado (desenvolvimento).
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function solveAltcha(onProgress) {
  const res = await fetch('/auth/altcha', { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('nao foi possivel carregar a verificacao anti-robo');
  const c = await res.json();
  const max = Number(c.maxnumber ?? 1_000_000);
  for (let n = 0; n <= max; n += 1) {
    if ((await sha256Hex(`${c.salt}${n}`)) === c.challenge) {
      return btoa(
        JSON.stringify({
          algorithm: c.algorithm,
          challenge: c.challenge,
          number: n,
          salt: c.salt,
          signature: c.signature,
        }),
      );
    }
    if (onProgress && n % 5000 === 0) onProgress(n / max);
  }
  throw new Error('verificacao anti-robo nao resolvida; recarregue a pagina');
}
