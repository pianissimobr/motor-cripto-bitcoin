/**
 * Limitador global de chamadas à LuniumPay.
 *
 * A Lunium aceita 60 requisições por minuto por chave. O motor pode passar
 * disso com ease: o job `pix-reconcile` roda a cada 30 s com lote de 50 e cada
 * cobranca consome uma chamada de status, ou seja, 100 req/min só no
 * reconciliador. Este limitador segura todas as chamadas num unico lugar:
 *
 * - balde de tokens: a taxa e `maxRequests` por janela, com uma rajada maxima
 *   pequena (evita estourar o limite do provedor com pico);
 * - prioridade: uma criacao de cobranca (interativa) passa na frente do
 *   reconciliador (que pode esperar);
 * - cooldown: um 429 do provedor pausa tudo pelo `retry-after` informado e
 *   reduz a taxa efetiva pela metade, ate o provedor voltar a responder bem.
 *
 * A fila e limitada: se ela encher, a chamada e recusada em vez de acumular
 * promessas pendentes (o worker chamaria o provedor em looping).
 */

export type RateLimitPriority = 'alta' | 'normal';

export type RateLimiterOptions = {
  /** Requisições permitidas por janela (taxa sustentada). */
  maxRequests: number;
  /** Tamanho da janela em ms. */
  windowMs: number;
  /** Tamanho máximo da fila de espera. */
  maxQueue?: number;
  /** Pausa aplicada quando o provedor não informa `retry-after`. */
  defaultCooldownMs?: number;
  /** Chamadas bem-sucedidas necessárias para subir a taxa efetiva. */
  restoreAfterSuccesses?: number;
  now?: () => number;
};

export class RateLimiterQueueFullError extends Error {
  constructor(maxQueue: number) {
    super(`fila de chamadas cheia (${maxQueue})`);
    this.name = 'RateLimiterQueueFullError';
  }
}

type Waiter = {
  priority: RateLimitPriority;
  resolve: () => void;
  reject: (err: unknown) => void;
  enqueuedAt: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rajada maxima liberada de uma vez. O balde recarrega na taxa sustentada,
 * então o pior caso numa janela e `rajada + taxa * janela`: as fatias da API e
 * do worker ja descontam isso do teto da Lunium.
 */
function burstCapacity(maxRequests: number): number {
  return Math.max(1, Math.min(maxRequests, 5));
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxQueue: number;
  private readonly defaultCooldownMs: number;
  private readonly restoreAfterSuccesses: number;
  private readonly now: () => number;

  private readonly waiters: Waiter[] = [];
  private cooldownUntil = 0;
  private effectiveMax: number;
  private tokens: number;
  private lastRefillAt: number;
  private consecutiveSuccesses = 0;
  private pumping = false;

  constructor(options: RateLimiterOptions) {
    this.maxRequests = Math.max(1, options.maxRequests);
    this.windowMs = Math.max(1, options.windowMs);
    this.maxQueue = Math.max(1, options.maxQueue ?? 100);
    this.defaultCooldownMs = Math.max(0, options.defaultCooldownMs ?? 60_000);
    this.restoreAfterSuccesses = Math.max(1, options.restoreAfterSuccesses ?? 10);
    this.now = options.now ?? (() => Date.now());
    this.effectiveMax = this.maxRequests;
    this.tokens = burstCapacity(this.effectiveMax);
    this.lastRefillAt = this.now();
  }

  /** Taxa efetiva no momento (pode estar reduzida por 429 anterior). */
  get currentLimit(): number {
    return this.effectiveMax;
  }

  /** Requisições aguardando vez. */
  get queueLength(): number {
    return this.waiters.length;
  }

  /**
   * Espera uma vez para poder chamar o provedor. Resolve quando há token
   * disponível e não há cooldown ativo.
   */
  acquire(priority: RateLimitPriority = 'normal'): Promise<void> {
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new RateLimiterQueueFullError(this.maxQueue));
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ priority, resolve, reject, enqueuedAt: this.now() });
      this.pump();
    });
  }

  /**
   * Chamada bem-sucedida: conta para restaurar a taxa efetiva depois de
   * um periodo de 429.
   */
  recordSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (
      this.effectiveMax < this.maxRequests &&
      this.consecutiveSuccesses >= this.restoreAfterSuccesses
    ) {
      this.effectiveMax = Math.min(this.maxRequests, this.effectiveMax + 1);
      this.consecutiveSuccesses = 0;
    }
  }

  /**
   * O provedor recusou (429). Pausa tudo pelo `retry-after` (ou pelo padrão) e
   * reduz a taxa efetiva pela metade, para não repetir a rajada.
   */
  recordThrottled(retryAfterMs?: number): void {
    const pause = Math.max(
      1_000,
      retryAfterMs !== undefined && retryAfterMs > 0
        ? retryAfterMs
        : this.defaultCooldownMs,
    );
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + pause);
    this.effectiveMax = Math.max(1, Math.floor(this.effectiveMax / 2));
    this.consecutiveSuccesses = 0;
    this.tokens = 0;
    this.lastRefillAt = this.now();
  }

  /** Espera que ainda resta de cooldown, em ms (0 quando liberada). */
  cooldownRemaining(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  /** Recarga os tokens conforme o tempo passado. */
  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefillAt);
    if (elapsed === 0) return;
    this.lastRefillAt = now;
    const rate = this.effectiveMax / this.windowMs;
    this.tokens = Math.min(
      burstCapacity(this.effectiveMax),
      this.tokens + elapsed * rate,
    );
  }

  /** Quanto falta (ms) para a próxima requisição poder sair. */
  private delayUntilReady(): number {
    const now = this.now();
    if (now < this.cooldownUntil) return this.cooldownUntil - now;
    this.refill();
    if (this.tokens >= 1) return 0;
    const rate = this.effectiveMax / this.windowMs;
    return Math.ceil((1 - this.tokens) / rate);
  }

  private takeNext(): Waiter | undefined {
    if (this.waiters.length === 0) return undefined;
    let bestIndex = 0;
    for (let i = 1; i < this.waiters.length; i++) {
      const candidate = this.waiters[i]!;
      const best = this.waiters[bestIndex]!;
      if (candidate.priority === best.priority) {
        if (candidate.enqueuedAt < best.enqueuedAt) bestIndex = i;
      } else if (candidate.priority === 'alta') {
        bestIndex = i;
      }
    }
    return this.waiters.splice(bestIndex, 1)[0];
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pumpLoop();
  }

  private async pumpLoop(): Promise<void> {
    try {
      while (this.waiters.length > 0) {
        const delay = this.delayUntilReady();
        if (delay > 0) {
          await sleep(delay);
          continue;
        }
        const waiter = this.takeNext();
        if (!waiter) break;
        this.refill();
        this.tokens = Math.max(0, this.tokens - 1);
        waiter.resolve();
      }
    } finally {
      this.pumping = false;
      if (this.waiters.length > 0) this.pump();
    }
  }
}
