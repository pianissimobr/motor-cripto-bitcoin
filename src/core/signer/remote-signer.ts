import { getAddress, keccak256 } from 'ethers';
import type { SignerMode } from '../config.js';
import {
  assertSignTransferInput,
  isHexData,
  type SignedTransaction,
  type Signer,
  type SignTransferInput,
  type UnsignedTransaction,
} from './signer.js';

/**
 * Signer remoto: o motor monta a transacao e a envia para um servico de
 * assinatura externo (Fireblocks, Gnosis Safe, KMS, HSM proprio).
 * A chave privada NUNCA toca este processo.
 *
 * Contrato do endpoint (POST {SIGNER_REMOTE_URL}/sign):
 *   body: { address, to, data, value, chainId, nonce, gasLimit, maxFeePerGas?, maxPriorityFeePerGas? }
 *   resp: { rawTransaction: "0x..." }
 */
export class RemoteSigner implements Signer {
  readonly mode: SignerMode = 'remote';

  constructor(
    private readonly options: {
      url: string;
      token?: string | undefined;
      /** Resolve o endereco publico do indice sem material de chave. */
      resolveAddress: (index: number) => string;
    },
  ) {}

  addressFor(index: number): string {
    return getAddress(this.options.resolveAddress(index));
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

  async signTransfer(input: SignTransferInput): Promise<SignedTransaction> {
    assertSignTransferInput(input);
    const url = `${this.options.url.replace(/\/$/, '')}/sign`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(this.buildUnsigned(input)),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`signer remoto respondeu ${response.status}: ${body.slice(0, 200)}`);
    }
    const payload = (await response.json()) as { rawTransaction?: string };
    if (!payload.rawTransaction || !isHexData(payload.rawTransaction) || payload.rawTransaction === '0x') {
      throw new Error('signer remoto devolveu rawTransaction invalido');
    }
    return {
      rawTransaction: payload.rawTransaction,
      hash: keccak256(payload.rawTransaction),
    };
  }

  describe(): string {
    return `remote(${this.options.url})`;
  }
}
