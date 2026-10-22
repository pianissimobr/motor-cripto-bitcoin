import { Wallet, type Provider } from 'ethers';
import { providerChainId } from './provider.js';

/**
 * Gas sponsor: enderecos derivados de HD Wallet nascem com saldo nativo 0,
 * e um transfer ERC-20 exige gas nativo para ser executado. Sem um
 * patrocinador, o valor recebido ficaria preso no endereco temporario.
 *
 * O patrocinador envia uma pequena quantia de POL/ETH para o endereco
 * derivado, que entao assina o proprio transfer. Custo: ~0,01 a 0,05 USD
 * por link na Polygon.
 *
 * A chave patrocinadora e uma chave operacional (NUNCA a seed da HD Wallet).
 */
export class GasSponsor {
  private readonly wallet: Wallet | null;

  constructor(
    privateKey: string | undefined,
    private readonly amountWei: bigint,
    private readonly minBalanceWei: bigint,
  ) {
    this.wallet = privateKey ? new Wallet(privateKey) : null;
  }

  get enabled(): boolean {
    return this.wallet !== null;
  }

  get address(): string | null {
    return this.wallet?.address ?? null;
  }

  /** Saldo nativo do patrocinador. */
  async balance(provider: Provider): Promise<bigint> {
    if (!this.wallet) return 0n;
    return provider.getBalance(this.wallet.address);
  }

  /**
   * Garante que o endereco destino tenha gas suficiente.
   * @returns true se o patrocinador enviou POL, false se ja havia gas
   */
  async ensureGas(
    provider: Provider,
    destination: string,
    feeData: { maxFeePerGas?: bigint; gasPrice?: bigint },
  ): Promise<boolean> {
    if (!this.wallet) return false;
    const balance = await provider.getBalance(destination);
    if (balance >= this.minBalanceWei) return false;

    const sponsorBalance = await this.balance(provider);
    const cost = this.amountWei + (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n) * 21000n;
    if (sponsorBalance < cost) {
      throw new Error(
        `gas sponsor sem saldo: tem ${sponsorBalance}, precisa de ${cost}. ` +
          'Recarregue a carteira patrocinadora.',
      );
    }

    const tx = await this.wallet.sendTransaction({
      to: destination,
      value: this.amountWei,
      chainId: providerChainId(provider),
      maxFeePerGas: feeData.maxFeePerGas,
      gasPrice: feeData.gasPrice,
    });
    await tx.wait();
    return true;
  }
}
