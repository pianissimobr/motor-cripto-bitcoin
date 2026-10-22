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

export class InvalidSignTransfer extends Error {
  constructor(message: string) {
    super(`transfer invalido: ${message}`);
    this.name = 'InvalidSignTransfer';
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export function isEvmAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

export function isHexData(value: string): boolean {
  return HEX_RE.test(value);
}

/**
 * Contrato de entrada da assinatura. Um `chainId` 0 (replay entre redes),
 * `nonce` negativo, `gasLimit` zero ou endereco malformado nao podem chegar
 * ao hardware wallet: falhar aqui e mais barato do que assinar lixo.
 */
export function assertSignTransferInput(input: SignTransferInput): void {
  if (!Number.isInteger(input.index) || input.index < 0) {
    throw new InvalidSignTransfer('index deve ser inteiro >= 0');
  }
  if (!isEvmAddress(input.to)) {
    throw new InvalidSignTransfer(`destino nao e endereco EVM: "${input.to}"`);
  }
  if (!isHexData(input.data)) {
    throw new InvalidSignTransfer('data deve ser hex 0x');
  }
  if (typeof input.value !== 'bigint' || input.value < 0n) {
    throw new InvalidSignTransfer('value deve ser bigint >= 0');
  }
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
    throw new InvalidSignTransfer('chainId deve ser inteiro > 0');
  }
  if (!Number.isInteger(input.nonce) || input.nonce < 0) {
    throw new InvalidSignTransfer('nonce deve ser inteiro >= 0');
  }
  if (typeof input.gasLimit !== 'bigint' || input.gasLimit <= 0n) {
    throw new InvalidSignTransfer('gasLimit deve ser bigint > 0');
  }
  if (input.maxFeePerGas !== undefined && input.maxFeePerGas < 0n) {
    throw new InvalidSignTransfer('maxFeePerGas deve ser >= 0');
  }
  if (input.maxPriorityFeePerGas !== undefined && input.maxPriorityFeePerGas < 0n) {
    throw new InvalidSignTransfer('maxPriorityFeePerGas deve ser >= 0');
  }
  if (
    input.maxFeePerGas !== undefined &&
    input.maxPriorityFeePerGas !== undefined &&
    input.maxPriorityFeePerGas > input.maxFeePerGas
  ) {
    throw new InvalidSignTransfer('maxPriorityFeePerGas nao pode exceder maxFeePerGas');
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
