import type {
  SweepSigner,
  SweepSignerRequest,
  SweepSignerResult,
} from './sweep-signer.js';

export class BtcPsbtSigner implements SweepSigner {
  readonly mode = 'psbt' as const;

  async signSweep(request: SweepSignerRequest): Promise<SweepSignerResult> {
    return { kind: 'manual', psbt: request.psbt };
  }

  describe(): string {
    return 'psbt(assinatura manual)';
  }
}
