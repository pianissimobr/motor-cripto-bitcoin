/**
 * Cliente HTTP do painel. Mesma origem do motor: o cookie de sessao vai
 * sozinho, e toda escrita leva o token CSRF (cookie `painel_csrf`, legivel
 * pelo JS) no header `x-csrf-token`.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function readCookie(name: string, source = typeof document === 'undefined' ? '' : document.cookie): string | null {
  for (const part of source.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

const SAFE = new Set(['GET', 'HEAD']);

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (!SAFE.has(method)) {
    const csrf = readCookie('painel_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'erro', data?.error?.message ?? `erro ${res.status}`);
  }
  return data as T;
}

/** Mensagem amigavel para mostrar ao usuario. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Muitas tentativas. Aguarde um pouco e tente de novo.';
    return err.message.charAt(0).toUpperCase() + err.message.slice(1);
  }
  return 'Nao foi possivel falar com o servidor. Verifique a conexao.';
}
