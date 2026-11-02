import type { Repositories } from './db/repositories.js';
import type { EsploraClient } from './adapters/chain/esplora.js';
import type { LuniumClient } from './adapters/lunium/client.js';
import type {
  Readiness,
  ReadinessCheck,
} from './http/readiness.js';

/**
 * Prontidao do motor. Nao ha carteira da plataforma para conferir: o
 * Bitcoin vai direto para as carteiras dos lojistas (LNbits e xpub de cada
 * um), entao so as dependencias compartilhadas entram aqui.
 */
export type ReadinessDeps = {
  onchainEnabled: boolean;
  repos: Repositories;
  esplora?: Pick<EsploraClient, 'health'>;
  lunium?: Pick<LuniumClient, 'health'>;
};

export function createReadiness(deps: ReadinessDeps): Readiness {
  const checks: ReadinessCheck[] = [
    {
      name: 'db',
      run: async () => {
        await deps.repos.ping();
        return { ok: true };
      },
    },
  ];

  if (deps.onchainEnabled) {
    checks.push({
      name: 'esplora',
      run: async () => {
        if (!deps.esplora) return { ok: false, detail: 'Esplora ausente' };
        const result = await deps.esplora.health();
        return result.ok
          ? {
              ok: true,
              ...(result.tipHeight !== undefined
                ? { tipHeight: result.tipHeight }
                : {}),
            }
          : { ok: false, detail: result.detail ?? 'Esplora indisponivel' };
      },
    });
  }

  if (deps.lunium) {
    checks.push({
      name: 'lunium',
      run: async () => {
        const result = await deps.lunium!.health();
        return result.ok
          ? { ok: true }
          : { ok: false, detail: result.detail ?? 'Lunium indisponivel' };
      },
    });
  }

  return { checks };
}
