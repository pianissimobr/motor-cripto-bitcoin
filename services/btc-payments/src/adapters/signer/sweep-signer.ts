import type { BtcNetworkName } from '../../config.js';
import type { AccountXpub } from '../hd/derivation.js';

export type SweepSignerInput = {
  addressIndex: number;
};

export type SweepSignerRequest = {
  psbt: string;
  inputs: SweepSignerInput[];
  network: BtcNetworkName;
};

export type SweepSignerResult =
  | {
      kind: 'signed';
      rawTx: string;
      txid: string;
      psbt: string;
    }
  | {
      kind: 'manual';
      psbt: string;
    };

export interface SweepSigner {
  readonly mode: 'local' | 'remote' | 'psbt';
  signSweep(request: SweepSignerRequest): Promise<SweepSignerResult>;
  describe(): string;
  verifyMatches?(
    xpub: AccountXpub,
    network: BtcNetworkName,
    prefix: string,
  ): void;
}
