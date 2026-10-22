import type { SignerMode } from '../config.js';

/**
 * Contrato de assinatura. O motor nunca conhece a chave privada: ele
 * apenas pede a assinatura de uma transacao para um indice derivado.
 *
 * Implementacoes:
 *  - LocalSigner  : keystore cifrado no servidor (dev / operacao pequena)
 *  - RemoteSigner : delega a assinatura a um servico externo (producao)
 *  - PsbtSigner   : nao assina; devolve a tx para assinatura manual (Ledger)
 */

export type SignTransferInput = {
  /** Indice HD do endereco que deve assinar. */
  index: number;
  /** Endereco de destino. */
  to: string;
  /** Calldata (ex.: ERC-20 transfer). */
  data: string;
  /** Valor nativo em wei (0 para ERC-20). */
  value: bigint;
  chainId: number;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export type SignedTransaction = {
  rawTransaction: string;
  hash: string;
};

export type UnsignedTransaction = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  nonce: number;
  gasLimit: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  from: string;
};

export class ManualSigningRequired extends Error {
  constructor(public readonly unsigned: UnsignedTransaction) {
    super(
      'assinatura manual necessaria: assine a transacao no seu hardware wallet e envie o rawTransaction',
    );
    this.name = 'ManualSigningRequired';
  }
}

export interface Signer {
  readonly mode: SignerMode;
  /** Endereco publico do indice derivado (sem expor material de chave). */
  addressFor(index: number): string;
  /** Assina a transacao. */
  signTransfer(input: SignTransferInput): Promise<SignedTransaction>;
  /** Prepara a transacao sem assinar (usado pelo modo psbt). */
  buildUnsigned(input: SignTransferInput): UnsignedTransaction;
  /** Descricao segura para logs (nunca inclui chave). */
  describe(): string;
}
