import { Wallet, getAddress, type Provider, type TransactionReceipt } from 'ethers';
import { providerChainId } from './provider.js';

/**
 * Gas sponsor: enderecos derivados de HD Wallet nascem com saldo nativo 0,
 * e um transfer ERC-20 exige gas nativo para ser executado. Sem um
 * patrocinador, o valor recebido ficaria preso no endereco temporario.
 *
 * O patrocinador envia uma pequena quantia de POL/ETH para o endereco
 * derivado, que entao assina o proprio transfer.
 *
 * A chave patrocinadora e uma chave operacional (NUNCA a seed da HD Wallet).
 * O processo HTTP usa `watchOnly`: sabe o endereco para consultar saldo e
 * nao carrega a chave.
 */
export class GasSponsor {
  private readonly wallet: Wallet | null;
  private readonly watchAddress: string | null;
  /**
   * Tx de patrocinio ainda nao encerrada, por destino.
   * Enquanto nao houver recibo de falha (ou saldo ainda baixo depois de um
   * recibo de sucesso), o mesmo endereco nao recebe outro envio.
   */
  private readonly sponsorships = new Map<string, string>();

  private constructor(
    wallet: Wallet | null,
    watchAddress: string | null,
    private readonly amountWei: bigint,
    private readonly minBalanceWei: bigint,
  ) {
    this.wallet = wallet;
    this.watchAddress = watchAddress;
  }

  /**
   * Patrocinador que assina. Se `expectedAddress` vier preenchido, a chave
   * precisa gerar exatamente esse endereco.
   */
  static fromPrivateKey(
    privateKey: string | undefined,
    amountWei: bigint,
    minBalanceWei: bigint,
    expectedAddress?: string,
  ): GasSponsor {
    if (!privateKey) {
      return GasSponsor.watchOnly(expectedAddress, amountWei, minBalanceWei);
    }
    const wallet = new Wallet(privateKey);
    if (expectedAddress && getAddress(wallet.address) !== getAddress(expectedAddress)) {
      throw new Error('GAS_SPONSOR_ADDRESS nao corresponde a GAS_SPONSOR_PRIVATE_KEY');
    }
    return new GasSponsor(wallet, getAddress(wallet.address), amountWei, minBalanceWei);
  }

  /** Consulta de saldo, sem chave. Usado pelo processo HTTP. */
  static watchOnly(
    address: string | undefined,
    amountWei: bigint,
    minBalanceWei: bigint,
  ): GasSponsor {
    const watch = address ? getAddress(address) : null;
    return new GasSponsor(null, watch, amountWei, minBalanceWei);
  }

  /** Consegue enviar gas. */
  get enabled(): boolean {
    return this.wallet !== null;
  }

  /** Endereco conhecido (chave ou so o endereco publico). */
  get configured(): boolean {
    return this.watchAddress !== null;
  }

  get address(): string | null {
    return this.watchAddress;
  }

  /** Saldo nativo do patrocinador. */
  async balance(provider: Provider): Promise<bigint> {
    if (!this.watchAddress) return 0n;
    return provider.getBalance(this.watchAddress);
  }

  /**
   * Garante que o endereco destino tenha gas suficiente.
   * @returns true se o patrocinador enviou nativo nesta chamada, false se ja havia gas
   *          ou se ja existe um patrocinio em voo para o mesmo destino.
   */
  async ensureGas(
    provider: Provider,
    destination: string,
    feeData: { maxFeePerGas?: bigint; gasPrice?: bigint },
  ): Promise<boolean> {
    if (!this.wallet) return false;
    const dest = getAddress(destination);

    const known = this.sponsorships.get(dest);
    if (known) {
      const receipt = await provider.getTransactionReceipt(known);
      if (!receipt) return false;
      const aindaBaixo = await this.balanceStillLow(provider, dest, receipt);
      this.sponsorships.delete(dest);
      if (!aindaBaixo) return false;
    }

    const balance = await provider.getBalance(dest);
    if (balance >= this.minBalanceWei) return false;

    const sponsorBalance = await this.balance(provider);
    const cost = this.amountWei + (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n) * 21000n;
    if (sponsorBalance < cost) {
      throw new Error(
        `gas sponsor sem saldo: tem ${sponsorBalance}, precisa de ${cost}. ` +
          'Recarregue a carteira patrocinadora.',
      );
    }

    const tx = await this.wallet.connect(provider).sendTransaction({
      to: dest,
      value: this.amountWei,
      chainId: providerChainId(provider),
      maxFeePerGas: feeData.maxFeePerGas,
      gasPrice: feeData.gasPrice,
    });
    this.sponsorships.set(dest, tx.hash);

    const receipt = await tx.wait();
    if (!receipt) return true;
    if (receipt.status !== 1) {
      this.sponsorships.delete(dest);
      throw new Error(`patrocinio de gas revertido (${tx.hash})`);
    }

    const depois = await provider.getBalance(dest);
    if (depois >= this.minBalanceWei) this.sponsorships.delete(dest);
    return true;
  }

  /**
   * Recibo de sucesso com saldo ainda abaixo do piso autoriza um novo envio.
   * Recibo de falha tambem. Saldo suficiente encerra a pendencia.
   */
  private async balanceStillLow(
    provider: Provider,
    destination: string,
    receipt: TransactionReceipt,
  ): Promise<boolean> {
    if (receipt.status !== 1) return true;
    const depois = await provider.getBalance(destination);
    return depois < this.minBalanceWei;
  }
}
