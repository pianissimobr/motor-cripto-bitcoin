import type { Repositories } from '../db/repositories.js';
import { ValidationError } from '../domain/errors.js';
import type { Logger } from '../logger.js';

export const APP_FLAGS_KEY = 'app_flags';

export type AppFlags = {
  cash_out_enabled: boolean;
  cash_in_enabled: boolean;
  min_cash_out_brl: number;
  max_cash_out_brl: number;
  default_asset: 'USDC';
  default_chain: 'polygon';
  max_amount_usd_per_operation: number;
};

export const DEFAULT_APP_FLAGS: AppFlags = {
  cash_out_enabled: true,
  cash_in_enabled: true,
  min_cash_out_brl: 5,
  max_cash_out_brl: 5000,
  default_asset: 'USDC',
  default_chain: 'polygon',
  max_amount_usd_per_operation: 100000,
};

export type FlagsServiceDeps = {
  repos: Repositories;
  logger: Logger;
};

/**
 * Flags do app lidas pelo motor (F7).
 *
 * O rollback nao pode depender de publicar nova versao do app: quem opera
 * muda a flag aqui e o app passa a recusar o fluxo na proxima leitura. O
 * valor gravado no banco e sempre mesclado sobre o padrao, entao uma flag
 * nova no motor nao quebra um app velho.
 */
export class FlagsService {
  constructor(private readonly deps: FlagsServiceDeps) {}

  async get(): Promise<{ flags: AppFlags; updated_at: string | null }> {
    const row = await this.deps.repos.getServiceFlag(APP_FLAGS_KEY);
    const flags = this.merge(row?.value ?? null);
    return {
      flags,
      updated_at: row?.updatedAt.toISOString() ?? null,
    };
  }

  async set(
    patch: Partial<AppFlags>,
  ): Promise<{ flags: AppFlags; updated_at: string }> {
    const current = await this.get();
    const merged = this.merge({ ...current.flags, ...patch });
    const saved = await this.deps.repos.setServiceFlag(APP_FLAGS_KEY, {
      ...merged,
    });
    await this.deps.repos.insertAuditEvent({
      actor: 'admin',
      action: 'flags.updated',
      entity: 'service_flag',
      entityId: APP_FLAGS_KEY,
      metadata: { patch: patch as Record<string, unknown> },
    });
    this.deps.logger.info({ flags: merged }, 'flags do app atualizadas');
    return { flags: merged, updated_at: saved.updatedAt.toISOString() };
  }

  private merge(value: Record<string, unknown> | null): AppFlags {
    const flags: AppFlags = { ...DEFAULT_APP_FLAGS };
    if (!value) return flags;
    for (const key of Object.keys(DEFAULT_APP_FLAGS) as Array<keyof AppFlags>) {
      const raw = value[key];
      if (raw === undefined || raw === null) continue;
      const expected = typeof DEFAULT_APP_FLAGS[key];
      if (expected === 'boolean' && typeof raw === 'boolean') {
        flags[key] = raw as never;
        continue;
      }
      if (expected === 'number' && typeof raw === 'number' && Number.isFinite(raw)) {
        flags[key] = raw as never;
        continue;
      }
      if (expected === 'string' && typeof raw === 'string') {
        flags[key] = raw as never;
      }
    }
    if (flags.min_cash_out_brl < 0) {
      throw new ValidationError('min_cash_out_brl nao pode ser negativo');
    }
    if (flags.max_cash_out_brl < flags.min_cash_out_brl) {
      throw new ValidationError('max_cash_out_brl abaixo do minimo');
    }
    return flags;
  }
}
