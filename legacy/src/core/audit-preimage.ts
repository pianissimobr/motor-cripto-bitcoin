/**
 * Pre-imagem do hash de auditoria.
 *
 * Cada campo entra com o tamanho em bytes na frente. Isso impede que
 * `ator="a|b"` e `acao="c"` produzam a mesma string que `ator="a"` e
 * `acao="b|c"`, que era o efeito do join por `|`.
 */
export function canonicalAuditPreimage(fields: readonly string[]): string {
  return fields
    .map((field) => {
      const bytes = Buffer.byteLength(field, 'utf8');
      return `${bytes}:${field}`;
    })
    .join('');
}
