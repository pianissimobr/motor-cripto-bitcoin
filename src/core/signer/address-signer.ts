import { getAddress } from 'ethers';
import type { SignerMode } from '../config.js';
import type { HdWallet } from '../hd/hd-wallet.js';
import {
  assertSignTransferInput,
  type SignedTransaction,
  type Signer,
  type SignTransferInput,
  type UnsignedTransaction,
} from './signer.js';

/**
 * Signer do processo HTTP: deriva endereco a partir do xpub e recusa assinar.
 * A chave privada fica apenas no worker.
 */
export class AddressOnlySigner implements Signer {
  readonly mode: SignerMode;

  constructor(
    private readonly hdWallet: HdWallet,
    mode: SignerMode,
  ) {
    this.mode = mode;
  }

  addressFor(index: number): string {
    return getAddress(this.hdWallet.deriveAddress(index));
  }

  buildUnsigned(input: SignTransferInput): UnsignedTransaction {
    assertSignTransferInput(input);
    throw new Error('processo HTTP nao assina transacoes');
  }

  async signTransfer(_input: SignTransferInput): Promise<SignedTransaction> {
    throw new Error('processo HTTP nao assina transacoes');
  }

  describe(): string {
    return `http(somente endereco, conta ${this.hdWallet.account.accountAddress})`;
  }
}
