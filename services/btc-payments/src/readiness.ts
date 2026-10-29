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
import type { Readiness } from './http/readiness.js';

export type ReadinessDeps = {
  network: BtcNetworkName;
  xpub: AccountXpub;
  coldWalletAddress?: string;
  sweepEnabled: boolean;
  repos: Repositories;
  lnbits: LnbitsClient;
  esplora: EsploraClient;
};

export function createReadiness(deps: ReadinessDeps): Readiness {
  return {
    checks: [
      {
        name: 'db',
        run: async () => {
          await deps.repos.ping();
          return { ok: true };
        },
      },
      {
        name: 'xpub',
        run: async () => {
          try {
            const derived = deriveAddress(
              deps.xpub,
              0,
              deps.network,
              '0',
            );
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
      },
      {
        name: 'cold_wallet',
        run: async () => {
          if (!deps.sweepEnabled) return { ok: true, detail: 'sweep desabilitado' };
          if (!deps.coldWalletAddress) {
            return { ok: false, detail: 'COLD_WALLET_ADDRESS ausente' };
          }
          const valid = validateAddress(deps.coldWalletAddress, deps.network);
          return valid
            ? { ok: true }
            : { ok: false, detail: 'COLD_WALLET_ADDRESS invalido para a rede' };
        },
      },
      {
        name: 'lnbits',
        run: async () => {
          const result = await deps.lnbits.health();
          return result.ok
            ? { ok: true }
            : { ok: false, detail: result.detail ?? 'LNbits indisponivel' };
        },
      },
      {
        name: 'esplora',
        run: async () => {
          const result = await deps.esplora.health();
          return result.ok
            ? { ok: true, tipHeight: result.tipHeight }
            : { ok: false, detail: result.detail ?? 'Esplora indisponivel' };
        },
      },
    ],
  };
}

export function parseConfiguredXpub(
  xpub: string,
  network: BtcNetworkName,
): AccountXpub {
  return parseAccountXpub(xpub, network);
}
