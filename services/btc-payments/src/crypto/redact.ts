/** Mascara um segredo para logs/diagnostico sem expor o valor. */
export function maskSecret(value: string, visible = 4): string {
  if (value.length <= visible * 2) return '*'.repeat(value.length);
  return `${value.slice(0, visible)}${'*'.repeat(Math.max(4, value.length - visible * 2))}${value.slice(-visible)}`;
}

/** Mostra apenas o prefixo de uma API key (ex.: mk_btc_live_ab12...). */
export function maskApiKey(value: string): string {
  if (value.length <= 16) return maskSecret(value);
  return `${value.slice(0, 16)}...`;
}

/** Redige um endereco/xpub para logs operacionais. */
export function maskAddress(value: string): string {
  if (value.length <= 12) return maskSecret(value);
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
