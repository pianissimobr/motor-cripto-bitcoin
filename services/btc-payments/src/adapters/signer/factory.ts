import type { AppConfig } from '../../config.js';
import { BtcLocalSigner } from './local.js';
import { BtcPsbtSigner } from './psbt.js';
import { BtcRemoteSigner } from './remote.js';
import type { SweepSigner } from './sweep-signer.js';

export function createSweepSigner(config: AppConfig): SweepSigner {
  if (config.signer.mode === 'local') {
    if (!config.signer.passphrase) {
      throw new Error('SIGNER_PASSPHRASE obrigatoria para SIGNER_MODE=local');
    }
    return BtcLocalSigner.fromKeystoreFile(
      config.signer.keystorePath,
      config.signer.passphrase,
      config.btc.network,
    );
  }
  if (config.signer.mode === 'remote') {
    if (!config.signer.remoteUrl) {
      throw new Error('SIGNER_REMOTE_URL obrigatoria para SIGNER_MODE=remote');
    }
    return new BtcRemoteSigner({
      url: config.signer.remoteUrl,
      ...(config.signer.remoteToken
        ? { token: config.signer.remoteToken }
        : {}),
    });
  }
  return new BtcPsbtSigner();
}
