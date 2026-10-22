/**
 * Normalizacao e mascaramento de PII.
 *
 * A UI nunca mostra email/nome completo por padrao: a revelacao e uma
 * acao explicita (e auditada). As funcoes de mascara sao deterministicas
 * para que o mesmo cadastro sempre apareca igual na listagem.
 */

/** Normaliza email para busca: minusculas, sem espacos nas pontas. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Mascara um email preservando o dominio e uma pista do local part.
 * `joao.silva@example.com` -> `j***@e***.com`
 */
export function maskEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at < 0) return '***';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const dot = domain.indexOf('.');
  const name = dot >= 0 ? domain.slice(0, dot) : domain;
  const tld = dot >= 0 ? domain.slice(dot) : '';
  const localHint = local.length > 0 ? `${local[0]!}***` : '***';
  const domainHint = name.length > 0 ? `${name[0]!}***` : '***';
  return `${localHint}@${domainHint}${tld}`;
}

/** Mascara um nome proprio: `Joao Silva` -> `J*** S***`. */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '***';
  return parts.map((p) => `${p[0]!}***`).join(' ');
}

/** Mascara um endereco EVM preservando o inicio e o fim. */
export function maskAddress(address: string): string {
  if (address.length <= 12) return '***';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
