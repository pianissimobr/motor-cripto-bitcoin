import type { BtcNetworkName } from './config.js';
import type { Repositories } from './db/repositories.js';
import {
  deriveAddress,
  parseAccountXpub,
  validateAddress,
  type AccountXpub,
} from './adapters/hd/derivation.js';
import type { EsploraClient } from './adapters/chain/esplora.js';
import type { LnbitsClient } from './adapters/lnbits/client.js';
import type { LuniumClient } from './adapters/lunium/client.js';
import type {
  Readiness,
  ReadinessCheck,
  ReadinessCheckResult,
} from './http/readiness.js';

export type ReadinessDeps = {
  network: BtcNetworkName;
  xpub?: AccountXpub;
  coldWalletAddress?: string;
  sweepEnabled: boolean;
  lightningEnabled: boolean;
  onchainEnabled: boolean;
  repos: Repositories;
  lnbits?: Pick<LnbitsClient, 'health'>;
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
      name: 'xpub',
      run: async (): Promise<ReadinessCheckResult> => {
        if (!deps.xpub) return { ok: false, detail: 'xpub ausente' };
        try {
          const derived = deriveAddress(deps.xpub, 0, deps.network, '0');
          if (!validateAddress(derived.address, deps.network)) {
            return { ok: false, detail: 'endereco derivado invalido' };
          }
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });
    checks.push({
      name: 'cold_wallet',
      run: async () => {
        if (!deps.sweepEnabled) {
          return { ok: true, detail: 'sweep desabilitado' };
        }
        if (!deps.coldWalletAddress) {
          return { ok: false, detail: 'COLD_WALLET_ADDRESS ausente' };
        }
        const valid = validateAddress(deps.coldWalletAddress, deps.network);
        return valid
          ? { ok: true }
          : { ok: false, detail: 'COLD_WALLET_ADDRESS invalido para a rede' };
      },
    });
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

  if (deps.lightningEnabled) {
    checks.push({
      name: 'lnbits',
      run: async () => {
        if (!deps.lnbits) return { ok: false, detail: 'LNbits ausente' };
        const result = await deps.lnbits.health();
        return result.ok
          ? { ok: true }
          : { ok: false, detail: result.detail ?? 'LNbits indisponivel' };
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

export function parseConfiguredXpub(
  xpub: string,
  network: BtcNetworkName,
): AccountXpub {
  return parseAccountXpub(xpub, network);
}
