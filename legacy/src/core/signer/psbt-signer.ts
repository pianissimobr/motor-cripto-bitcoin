import { getAddress } from 'ethers';
import type { SignerMode } from '../config.js';
import {
  assertSignTransferInput,
  ManualSigningRequired,
  type Signer,
  type SignTransferInput,
  type UnsignedTransaction,
} from './signer.js';

/**
 * Signer PSBT/manual: o motor NUNCA assina. Ele prepara a transacao e o
 * operador assina no hardware wallet (Ledger/Trezor) ou num servico de
 * custodia, devolvendo o rawTransaction.
 *
 * O sweeper detecta o modo e deixa a transferencia em `pendente`, expondo a
 * tx para assinatura manual.
 */
export class PsbtSigner implements Signer {
  readonly mode: SignerMode = 'psbt';

  constructor(private readonly resolveAddress: (index: number) => string) {}

  addressFor(index: number): string {
    return getAddress(this.resolveAddress(index));
  }

  buildUnsigned(input: SignTransferInput): UnsignedTransaction {
    assertSignTransferInput(input);
    return {
      from: this.addressFor(input.index),
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

  async signTransfer(input: SignTransferInput): Promise<never> {
    // Fail-fast com a transacao REAL pendente de assinatura, nao um esqueleto
    // vazio: o operador precisa do payload para assinar no hardware wallet.
    throw new ManualSigningRequired(this.buildUnsigned(input));
  }

  describe(): string {
    return 'psbt(assinatura manual)';
  }
}
