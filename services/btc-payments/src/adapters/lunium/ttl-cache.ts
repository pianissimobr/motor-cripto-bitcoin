/**
 * Cache em memória com TTL, sem dependência externa.
 *
 * Usado para as respostas da Lunium que mudam devagar e custam uma requisição
 * cada: o catálogo (pares de cripto aceitos) e os limites do pagador. Também
 * deduplica requisições simultâneas: duas chamadas com a mesma chave durante
 * a mesma janela compartilham uma única ida ao provedor.
 */

export type TtlCacheOptions = {
  ttlMs: number;
  now?: () => number;
};

type Entry<T> = {
  value: T;
  expiresAt: number;
};

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = Math.max(0, options.ttlMs);
    this.now = options.now ?? (() => Date.now());
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** Invalida uma entrada (ou todas, quando `key` é omitido). */
  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  /**
   * Devolve o valor em cache ou chama `loader`. Requisições simultâneas com a
   * mesma chave compartilham a mesma execução do loader.
   */
  async wrap(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = loader()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }
}
