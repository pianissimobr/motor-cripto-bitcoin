import { hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import type { BtcNetworkName } from '../../config.js';
import { HdWalletError, deriveAddress, hdVersionsForNetwork, networkFor, type AccountXpub } from '../hd/derivation.js';
import { decryptKeystore, readKeystoreFile } from './keystore.js';
import type {
  SweepSigner,
  SweepSignerRequest,
  SweepSignerResult,
} from './sweep-signer.js';

export class BtcLocalSigner implements SweepSigner {
  readonly mode = 'local' as const;

  private constructor(
    private readonly account: HDKey,
    private readonly network: BtcNetworkName,
    private readonly prefix: string,
  ) {}

  static fromKeystoreFile(
    path: string,
    passphrase: string,
    expectedNetwork: BtcNetworkName,
  ): BtcLocalSigner {
    const file = readKeystoreFile(path);
    const payload = decryptKeystore(file, passphrase);
    if (payload.network !== expectedNetwork) {
      throw new HdWalletError(
        `keystore e da rede ${payload.network}, mas BTC_NETWORK=${expectedNetwork}`,
      );
    }
    const account = HDKey.fromExtendedKey(
      payload.xprv,
      hdVersionsForNetwork(expectedNetwork),
    );
    if (account.depth !== 3) {
      throw new HdWalletError(
        `xprv do keystore com depth ${account.depth}; esperado depth 3 (conta BIP84)`,
      );
    }
    return new BtcLocalSigner(
      account,
      expectedNetwork,
      payload.derivationPrefix,
    );
  }

  /** Apenas para testes/diagnostico. Nunca use em producao. */
  static fromAccountXprv(
    xprv: string,
    network: BtcNetworkName,
    prefix = '0',
  ): BtcLocalSigner {
    const account = HDKey.fromExtendedKey(xprv, hdVersionsForNetwork(network));
    if (account.depth !== 3) {
      throw new HdWalletError(
        `xprv com depth ${account.depth}; esperado depth 3 (conta BIP84)`,
      );
    }
    return new BtcLocalSigner(account, network, prefix);
  }

  verifyMatches(
    xpub: AccountXpub,
    network: BtcNetworkName,
    prefix: string,
  ): void {
    if (network !== this.network || prefix !== this.prefix) {
      throw new HdWalletError('keystore nao corresponde a rede/prefixo configurados');
    }
    const child = this.account.derive(`m/${this.prefix}/0`);
    if (!child.publicKey) throw new HdWalletError('keystore sem chave publica');
    const address = btc.p2wpkh(child.publicKey, networkFor(network)).address;
    const expected = deriveAddress(xpub, 0, network, prefix).address;
    if (!address || address !== expected) {
      throw new HdWalletError(
        'keystore nao corresponde ao BTC_XPUB configurado',
      );
    }
  }

  async signSweep(request: SweepSignerRequest): Promise<SweepSignerResult> {
    if (request.network !== this.network) {
      throw new HdWalletError('rede do PSBT diferente da rede do signer');
    }
    const tx = btc.Transaction.fromPSBT(hex.decode(request.psbt));
    if (request.inputs.length !== tx.inputsLength) {
      throw new HdWalletError(
        `PSBT tem ${tx.inputsLength} inputs, mas ${request.inputs.length} indices foram informados`,
      );
    }

    for (let i = 0; i < tx.inputsLength; i++) {
      const addressIndex = request.inputs[i]!.addressIndex;
      const child = this.account.derive(`m/${this.prefix}/${addressIndex}`);
      if (!child.privateKey) {
        throw new HdWalletError(`chave privada ausente no indice ${addressIndex}`);
      }
      tx.signIdx(child.privateKey, i);
      tx.finalizeIdx(i);
    }

    const raw = tx.extract();
    return {
      kind: 'signed',
      rawTx: hex.encode(raw),
      txid: tx.id,
      psbt: hex.encode(tx.toPSBT()),
    };
  }

  describe(): string {
    return 'local(keystore cifrado, conta BIP84)';
  }
}
