import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { LuniumLimits, stricter } from '../src/services/lunium-limits.js';

// Recorte da resposta real de GET /keys/me (producao, 2026-11-08).
const KEYS_ME = {
  limits: {
    per_operation: {
      cashin: { min_brl_cents: 102, max_brl_cents: 600000 },
      cashout: { min_brl_cents: 600, max_brl_cents: 25000000 },
    },
    cashin_min_por_rota: {
      rotas: [
        { asset: 'USDC', network: 'arbitrum', min_brl_cents: 400 },
        { asset: 'USDC', network: 'polygon', min_brl_cents: 700 },
      ],
    },
  },
};

describe('limites ao vivo da Lunium', () => {
  it('cash-in: o piso da rota vale quando e maior que o da conta', async () => {
    const limits = new LuniumLimits({ lunium: { getKeyInfo: async () => KEYS_ME }, logger: silentLogger, asset: 'usdc', network: 'polygon' });
    expect(await limits.get()).toEqual({ cashin: { min: 700n, max: 600000n }, cashout: { min: 600n, max: 25000000n } });
  });

  it('cacheia por 10 min; falha cai para null (e a configuracao vale)', async () => {
    let calls = 0;
    let fail = false;
    let now = 0;
    const limits = new LuniumLimits({
      lunium: {
        getKeyInfo: async () => {
          calls += 1;
          if (fail) throw new Error('503');
          return KEYS_ME;
        },
      },
      logger: silentLogger,
      asset: 'usdc',
      network: 'polygon',
      now: () => now,
    });
    await limits.get();
    now += 300_000;
    await limits.get();
    expect(calls).toBe(1);
    fail = true;
    now += 600_001;
    expect(await limits.get()).toBeNull();
  });

  it('vale o mais restrito entre configuracao e Lunium', () => {
    expect(stricter({ min: 102n, max: 600000n }, { min: 700n, max: null })).toEqual({ min: 700n, max: 600000n });
    expect(stricter({ min: 1000n, max: 50000n }, { min: 700n, max: 600000n })).toEqual({ min: 1000n, max: 50000n });
    expect(stricter({ min: 102n, max: 600000n }, undefined)).toEqual({ min: 102n, max: 600000n });
  });
});
