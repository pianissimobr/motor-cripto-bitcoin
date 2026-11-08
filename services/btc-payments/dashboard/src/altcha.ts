/**
 * Anti-robo (ALTCHA) sem biblioteca: busca o desafio em /auth/altcha (que
 * repassa o do authO) e acha o numero cujo SHA-256 bate. Devolve o payload
 * em base64 para mandar como `altcha`, ou `null` com o anti-robo desligado.
 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

type Challenge = { algorithm: string; challenge: string; salt: string; signature: string; maxnumber?: number };

export async function solveChallenge(c: Challenge): Promise<string> {
  const max = Number(c.maxnumber ?? 1_000_000);
  for (let n = 0; n <= max; n += 1) {
    if ((await sha256Hex(`${c.salt}${n}`)) === c.challenge) {
      return btoa(
        JSON.stringify({ algorithm: c.algorithm, challenge: c.challenge, number: n, salt: c.salt, signature: c.signature }),
      );
    }
  }
  throw new Error('verificacao anti-robo nao resolvida; recarregue a pagina');
}

export async function solveAltcha(): Promise<string | null> {
  const res = await fetch('/auth/altcha', { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('nao foi possivel carregar a verificacao anti-robo');
  return solveChallenge((await res.json()) as Challenge);
}
