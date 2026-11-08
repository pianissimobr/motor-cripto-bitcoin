import type { LuniumClient } from '../adapters/lunium/client.js';
import type { Logger } from '../logger.js';

export type LiveLimits = {
  cashin: { min: bigint | null; max: bigint | null };
  cashout: { min: bigint | null; max: bigint | null };
};

type KeysMe = {
  limits?: {
    per_operation?: Record<string, { min_brl_cents?: number; max_brl_cents?: number } | undefined>;
    cashin_min_por_rota?: { rotas?: { asset?: string; network?: string; min_brl_cents?: number }[] };
  };
};

const toCents = (v: unknown): bigint | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? BigInt(Math.round(v)) : null);

/**
 * Limites vigentes da chave na Lunium (`GET /keys/me`), em cache. O minimo do
 * cash-in e o maior entre o piso da conta e o piso da rota que o motor usa
 * (ex.: USDC/Polygon = R$ 7,00 hoje): com o piso de configuracao (R$ 1,02),
 * cobrancas abaixo do da rota eram recusadas pela Lunium.
 *
 * Falha na consulta: `null` e quem chama usa os limites da configuracao.
 */
export class LuniumLimits {
  private cache: { at: number; value: LiveLimits | null } | null = null;

  constructor(
    private readonly deps: {
      lunium: Pick<LuniumClient, 'getKeyInfo'>;
      logger: Logger;
      /** Moeda e rede do cash-in (para o piso da rota). */
      asset: string;
      network: string;
      ttlMs?: number;
      now?: () => number;
    },
  ) {}

  async get(): Promise<LiveLimits | null> {
    const now = this.deps.now?.() ?? Date.now();
    const ttl = this.deps.ttlMs ?? 600_000;
    if (this.cache && now - this.cache.at < (this.cache.value ? ttl : 60_000)) return this.cache.value;
    let value: LiveLimits | null = null;
    try {
      const me = (await this.deps.lunium.getKeyInfo()) as KeysMe;
      const op = me.limits?.per_operation ?? {};
      const route = me.limits?.cashin_min_por_rota?.rotas?.find(
        (r) => r.asset?.toUpperCase() === this.deps.asset.toUpperCase() && r.network?.toLowerCase() === this.deps.network.toLowerCase(),
      );
      const accountMin = toCents(op.cashin?.min_brl_cents);
      const routeMin = toCents(route?.min_brl_cents);
      value = {
        cashin: {
          min: accountMin !== null && routeMin !== null ? (accountMin > routeMin ? accountMin : routeMin) : (routeMin ?? accountMin),
          max: toCents(op.cashin?.max_brl_cents),
        },
        cashout: { min: toCents(op.cashout?.min_brl_cents), max: toCents(op.cashout?.max_brl_cents) },
      };
    } catch (err) {
      this.deps.logger.warn({ err }, 'limites da Lunium indisponiveis; usando os da configuracao');
    }
    this.cache = { at: now, value };
    return value;
  }
}

/** O mais restritivo entre a configuracao e o limite ao vivo. */
export function stricter(config: { min: bigint; max: bigint }, live: { min: bigint | null; max: bigint | null } | undefined) {
  return {
    min: live?.min != null && live.min > config.min ? live.min : config.min,
    max: live?.max != null && live.max < config.max ? live.max : config.max,
  };
}
