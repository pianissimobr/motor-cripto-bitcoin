export type AppErrorOptions = {
  code: string;
  statusCode: number;
  details?: unknown;
  expose?: boolean;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(message: string, opts: AppErrorOptions) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.details = opts.details;
    this.expose = opts.expose ?? opts.statusCode < 500;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { code: 'validation_error', statusCode: 400, details });
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'nao autorizado') {
    super(message, { code: 'unauthorized', statusCode: 401 });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'proibido') {
    super(message, { code: 'forbidden', statusCode: 403 });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, { code: 'not_found', statusCode: 404 });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { code: 'conflict', statusCode: 409, details });
    this.name = 'ConflictError';
  }
}

export class UpstreamError extends AppError {
  constructor(message: string, opts?: { details?: unknown; cause?: unknown }) {
    super(message, {
      code: 'upstream_error',
      statusCode: 502,
      details: opts?.details,
      cause: opts?.cause,
    });
    this.name = 'UpstreamError';
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, {
      code: 'service_unavailable',
      statusCode: 503,
      details,
    });
    this.name = 'ServiceUnavailableError';
  }
}
