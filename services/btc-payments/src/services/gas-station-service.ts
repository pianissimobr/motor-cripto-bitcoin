import type { AppConfig } from '../config.js';
import {
  GasStationError,
  sendNative,
  treasuryBalance,
  type GasStationConfig,
} from '../adapters/chain/gas-station.js';
import type { Repositories } from '../db/repositories.js';
import { ValidationError } from '../domain/errors.js';
import type { Logger } from '../logger.js';

export type GasStationServiceDeps = {
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  now?: () => Date;
};

/**
 * Reposicao de gas (nativo) para a carteira do cliente.
 *
 * Por que existe: pagar um Pix com cripto e uma transferencia ERC-20 comum e
 * o gas sai de quem paga. O usuario tem a stablecoin, nao o nativo. Em vez de
 * exigir que ele compre POL na Polygon, o motor empresta o nativo da
 * tesouraria e reembolsa o custo no extrato.
 *
 * A tesouraria se paga com o que o motor ganha nas operacoes (a taxa da
 * LuniumPay e, depois, a comissao de parceiro). O custo por operacao sao
 * centavos.
 */
export class GasStationService {
  constructor(private readonly deps: GasStationServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private stationConfig(): GasStationConfig {
    const gas = this.deps.config.gasStation;
    return {
      enabled: gas.enabled,
      ...(gas.privateKey ? { privateKey: gas.privateKey } : {}),
      rpcUrls: gas.rpcUrls,
      chainId: gas.chainId,
      maxTopUpWei: gas.maxTopUpWei,
      minTreasuryWei: gas.minTreasuryWei,
    };
  }

  /** `true` quando a gas station esta ligada e com chave. */
  isEnabled(): boolean {
    const gas = this.deps.config.gasStation;
    return gas.enabled && Boolean(gas.privateKey);
  }

  /**
   * Repoe nativo na carteira do cliente.
   *
   * `amountWei` e o que falta; o teto vem da configuracao (a reposicao nao e
   * para encher a carteira degas: e so para a proxima operacao).
   */
  async topUp(input: {
    clientId: string;
    address: string;
    chain: string;
    amountWei: bigint;
    reason?: string;
  }): Promise<{ hash: string; amountWei: bigint; from: string }> {
    if (!/^0x[a-fA-F0-9]{40}$/.test(input.address)) {
      throw new ValidationError('endereco invalido para reposicao de gas');
    }
    if (input.chain !== 'polygon') {
      throw new ValidationError(`rede sem gas station: ${input.chain}`);
    }
    const config = this.stationConfig();
    if (!config.enabled) {
      throw new GasStationError('gas station desabilitada', 'gas_station_off');
    }

    const sent = await sendNative({
      config,
      to: input.address,
      amountWei: input.amountWei,
    });

    await this.deps.repos.insertAuditEvent({
      actor: 'gas_station',
      action: 'gas.topped_up',
      entity: 'api_client',
      entityId: input.clientId,
      metadata: {
        address: input.address,
        chain: input.chain,
        amountWei: input.amountWei.toString(),
        txHash: sent.hash,
        reason: input.reason ?? 'gas_reserve',
        at: this.now().toISOString(),
      },
    });

    this.deps.logger.info(
      {
        clientId: input.clientId,
        address: input.address,
        amountWei: input.amountWei.toString(),
        txHash: sent.hash,
      },
      'gas reposto para a carteira do cliente',
    );

    return { hash: sent.hash, amountWei: input.amountWei, from: sent.from };
  }

  /** Situacao da tesouraria (para o alerta de piso e o painel do motor). */
  async status(): Promise<{
    enabled: boolean;
    address?: string;
    balanceWei?: string;
    minTreasuryWei: string;
    maxTopUpWei: string;
  }> {
    const config = this.stationConfig();
    if (!config.enabled) {
      return {
        enabled: false,
        minTreasuryWei: config.minTreasuryWei.toString(),
        maxTopUpWei: config.maxTopUpWei.toString(),
      };
    }
    try {
      const balance = await treasuryBalance({ config });
      return {
        enabled: true,
        address: balance.address,
        balanceWei: balance.balanceWei.toString(),
        minTreasuryWei: config.minTreasuryWei.toString(),
        maxTopUpWei: config.maxTopUpWei.toString(),
      };
    } catch (err) {
      this.deps.logger.warn({ err }, 'nao foi possivel ler a tesouraria de gas');
      return {
        enabled: true,
        minTreasuryWei: config.minTreasuryWei.toString(),
        maxTopUpWei: config.maxTopUpWei.toString(),
      };
    }
  }
}
