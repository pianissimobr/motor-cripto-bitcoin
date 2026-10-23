/**
 * Erros de dominio com status HTTP seguro.
 *
 * A borda HTTP nao deve adivinhar o status de um `Error` generico: erro de
 * validacao vira 400, recurso ausente vira 404 e conflito vira 409. Sem isso
 * um cliente inexistente ou um valor invalido chega ao operador como 500,
 * escondendo a causa e sujando os logs.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly codigo: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, codigo = 'dados_invalidos') {
    super(message, 400, codigo);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string, codigo = 'nao_encontrado') {
    super(message, 404, codigo);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string, codigo = 'acesso_negado') {
    super(message, 403, codigo);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message: string, codigo = 'nao_autorizado') {
    super(message, 401, codigo);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, codigo = 'conflito') {
    super(message, 409, codigo);
  }
}

/** Violacao de unique do Postgres, inclusive quando embrulhada pelo driver. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
