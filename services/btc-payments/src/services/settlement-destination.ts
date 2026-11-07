import { ValidationError } from '../domain/errors.js';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';

/**
 * Endereco que recebe o USDC de uma operacao.
 *
 * A regra e a mesma para o cash-in (LuniumPay) e para o swap (SwapKit): o
 * dinheiro vai para a carteira de quem vai receber.
 *
 * - `usuario` (perfil pessoal do app): o `settlement_address` do cliente.
 * - `loja`: a carteira `usdc_settlement` da propria loja ou, quando a loja
 *   esta vendendo para um cliente com carteira no app (F4), o endereco
 *   cadastrado pela loja — que precisa estar registrado e nao revogado.
 */
export async function resolveSettlementDestination(input: {
  repos: Repositories;
  config: AppConfig;
  clientId: string;
  explicit?: string | null;
}): Promise<string | null> {
  const { repos, config, clientId } = input;
  const explicit = input.explicit ?? null;

  if (explicit) {
    const address = explicit.toLowerCase();
    const revoked = await repos.isAddressRevoked(address, clientId);
    if (revoked) {
      throw new ValidationError(
        'o dono do endereco revogou o uso dele por esta loja',
      );
    }
    const wallet = await repos.findMerchantWalletByChainAddress(
      config.settlement.chain,
      address,
    );
    if (!wallet || wallet.merchantId !== clientId || wallet.status !== 'ativo') {
      throw new ValidationError(
        'endereco nao cadastrado por esta loja para liquidacao USDC',
      );
    }
    // A carteira da propria loja e a de um cliente (F4) sao destinos validos;
    // o que nao pode e o endereco de outra loja.
    return address;
  }

  const client = await repos.findClientById(clientId);
  if (client?.settlementAddress) {
    return client.settlementAddress.toLowerCase();
  }
  const wallet = await repos.findActiveUsdcSettlementWalletForClient(clientId);
  return wallet?.address ?? null;
}
