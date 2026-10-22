import { Transaction, Wallet, getAddress, keccak256 } from 'ethers';
import type { SignerMode } from '../config.js';
import { HdWallet } from '../hd/hd-wallet.js';
import { decryptKeystore, readKeystoreFile } from '../hd/keystore.js';
import {
  assertSignTransferInput,
  type SignedTransaction,
  type Signer,
  type SignTransferInput,
  type UnsignedTransaction,
} from './signer.js';

/**
 * Signer local: usa um keystore cifrado (scrypt + AES-256-GCM) guardado em
 * disco com permissao 0600. A senha vem do ambiente / secret manager.
 *
 * O material de chave existe em memoria apenas durante a assinatura.
 */
export class LocalSigner implements Signer {
  readonly mode: SignerMode = 'local';
  private readonly wallet: HdWallet;
  private readonly privateKeys = new Map<number, string>();

  private constructor(wallet: HdWallet) {
    this.wallet = wallet;
  }

  static fromKeystoreFile(path: string, passphrase: string): LocalSigner {
    const file = readKeystoreFile(path);
    const payload = decryptKeystore(file, passphrase);
    const wallet = HdWallet.fromAccountXprv(
      payload.xprv,
      payload.derivationPrefix,
      payload.accountIndex,
    );
    return new LocalSigner(wallet);
  }

  static fromXprv(xprv: string, prefix = '0', accountIndex = 0): LocalSigner {
    return new LocalSigner(HdWallet.fromAccountXprv(xprv, prefix, accountIndex));
  }

  addressFor(index: number): string {
    return this.wallet.deriveAddress(index);
  }

  /**
   * Garante que o xprv do keystore e o xpub usado para criacao de links sao
   * a mesma conta HD. Sem essa checagem, a API poderia gerar enderecos de
   * deposito que o signer local nao consegue mover.
   */
  verifyMatches(hdWallet: HdWallet): void {
    if (
      getAddress(this.wallet.account.accountAddress) !==
        getAddress(hdWallet.account.accountAddress) ||
      this.wallet.deriveAddress(0) !== hdWallet.deriveAddress(0) ||
      this.wallet.derivationPrefix !== hdWallet.derivationPrefix ||
      this.wallet.accountIndex !== hdWallet.accountIndex
    ) {
      throw new Error(
        'keystore local nao corresponde ao HD_XPUB/HD_ACCOUNT_INDEX configurado',
      );
    }
  }

  privateKeyFor(index: number): string {
    let key = this.privateKeys.get(index);
    if (!key) {
      key = this.wallet.derivePrivateKey(index);
      this.privateKeys.set(index, key);
    }
    return key;
  }

  buildUnsigned(input: SignTransferInput): UnsignedTransaction {
    assertSignTransferInput(input);
    const from = getAddress(this.addressFor(input.index));
    return {
      from,
      to: getAddress(input.to),
      data: input.data,
      value: input.value.toString(),
      chainId: input.chainId,
      nonce: input.nonce,
      gasLimit: input.gasLimit.toString(),
      ...(input.maxFeePerGas !== undefined
        ? { maxFeePerGas: input.maxFeePerGas.toString() }
        : {}),
      ...(input.maxPriorityFeePerGas !== undefined
        ? { maxPriorityFeePerGas: input.maxPriorityFeePerGas.toString() }
        : {}),
    };
  }

  async signTransfer(input: SignTransferInput): Promise<SignedTransaction> {
    assertSignTransferInput(input);
    const wallet = new Wallet(this.privateKeyFor(input.index));
    const tx = {
      to: getAddress(input.to),
      data: input.data,
      value: input.value,
      chainId: input.chainId,
      nonce: input.nonce,
      gasLimit: input.gasLimit,
      ...(input.maxFeePerGas !== undefined ? { maxFeePerGas: input.maxFeePerGas } : {}),
      ...(input.maxPriorityFeePerGas !== undefined
        ? { maxPriorityFeePerGas: input.maxPriorityFeePerGas }
        : {}),
    };
    const raw = await wallet.signTransaction(tx);
    return { rawTransaction: raw, hash: keccak256(raw) };
  }

  describe(): string {
    return `local(keystore cifrado, conta ${this.wallet.account.accountAddress})`;
  }

  /** Usado apenas em testes/diagnostico. */
  static parseRawTransaction(raw: string): Transaction {
    return Transaction.from(raw);
  }
}
