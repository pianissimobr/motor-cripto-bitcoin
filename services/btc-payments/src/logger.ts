import pino from 'pino';

export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => Logger;
};

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["x-signature"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers["x-signature"]',
  'apiKey',
  'api_key',
  'requestSecret',
  'request_secret',
  'webhookSecret',
  'webhook_secret',
  'xpub',
  'xprv',
  'seed',
  'mnemonic',
  'passphrase',
  'invoice',
  'payment_request',
  'psbt',
  'rawTx',
  'token',
];

export function createPinoLogger(opts: {
  level: string;
  pretty?: boolean;
}): pino.Logger {
  return pino({
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(opts.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
  });
}

export function createLogger(opts: {
  level: string;
  pretty?: boolean;
}): Logger {
  const base = createPinoLogger(opts);

  const wrap = (instance: pino.Logger): Logger => ({
    debug: (obj, msg) => instance.debug(obj as object, msg),
    info: (obj, msg) => instance.info(obj as object, msg),
    warn: (obj, msg) => instance.warn(obj as object, msg),
    error: (obj, msg) => instance.error(obj as object, msg),
    child: (bindings) => wrap(instance.child(bindings)),
  });

  return wrap(base);
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
