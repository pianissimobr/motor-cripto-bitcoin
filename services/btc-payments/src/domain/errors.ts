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

/**
 * Cotacao expirada: o cliente precisa cotar de novo (com outro external_id).
 *
 * Continua 400 (era um `validation_error`), mas com codigo proprio: o app
 * decidia pela mensagem, e mensagem nao e contrato.
 */
export class QuoteExpiredError extends AppError {
  constructor(message = 'cotacao expirada: faca uma nova cotacao') {
    super(message, { code: 'quote_expired', statusCode: 400 });
    this.name = 'QuoteExpiredError';
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

/**
 * A loja precisa de uma carteira USDC (Base) cadastrada antes de cobrar:
 * e nela que o dolar digital e entregue.
 */
export class SettlementWalletRequiredError extends AppError {
  constructor() {
    super(
      'cadastre uma carteira usdc_settlement (endereco 0x na Base) antes de criar cobrancas',
      { code: 'settlement_wallet_required', statusCode: 409 },
    );
  }
}

/**
 * Cobranca em Bitcoin sem carteira do lojista para receber: ele precisa
 * cadastrar a wallet LNbits (Lightning) e/ou o xpub (on-chain).
 */
export class BitcoinWalletRequiredError extends AppError {
  constructor() {
    super(
      'cadastre uma carteira Lightning (LNbits) ou um xpub BTC antes de criar cobrancas em Bitcoin',
      { code: 'bitcoin_wallet_required', statusCode: 409 },
    );
  }
}

/**
 * O xpub do lojista chegou ao gap limit: ha enderecos seguidos demais sem
 * deposito e a carteira dele deixaria de enxergar os proximos.
 */
export class GapLimitReachedError extends AppError {
  constructor(gapLimit: number) {
    super(
      `o xpub da loja tem ${gapLimit} enderecos seguidos sem uso (gap limit). Aumente o gap limit na sua carteira e no motor, ou cadastre um novo xpub`,
      { code: 'gap_limit_reached', statusCode: 409 },
    );
  }
}
