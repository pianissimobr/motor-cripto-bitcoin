/**
 * Logger minimo usado pelo core. Compativel com pino, sem depender dele:
 * quem instancia o motor injeta qualquer logger com esta forma.
 */
export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
