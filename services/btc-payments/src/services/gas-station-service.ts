import type { AppConfig } from '../config.js';
import {
  GasStationError,
  nativeBalanceOf,
  sendNative,
  treasuryBalance,
  type GasStationConfig,
} from '../adapters/chain/gas-station.js';
import type { Repositories } from '../db/repositories.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Logger } from '../logger.js';

/** Acesso a rede (injetavel nos testes). */
export type GasStationChain = {
  balanceOf: (config: GasStationConfig, address: string) => Promise<bigint>;
  send: (
    config: GasStationConfig,
    to: string,
    amountWei: bigint,
  ) => Promise<{ hash: string; from: string }>;
};

const defaultChain: GasStationChain = {
  balanceOf: (config, address) => nativeBalanceOf({ config, address }),
  send: (config, to, amountWei) => sendNative({ config, to, amountWei }),
};

export type GasStationServiceDeps = {
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  now?: () => Date;
  chain?: GasStationChain;
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

  private chain(): GasStationChain {
    return this.deps.chain ?? defaultChain;
  }

  /**
   * Repoe o gas de uma venda (cash-out) do proprio cliente.
   *
   * E a unica porta publica da gas station. As regras fecham o abuso:
   *  - a ordem precisa ser do cliente (senao 404);
   *  - so ordem aceita, com endereco de deposito e ainda sem `tx_hash`;
   *  - o destino e o `origin_address` da ordem, nunca um endereco do corpo;
   *  - uma reposicao por ordem, reservada antes do envio;
   *  - so o que falta para chegar a folga (`maxTopUpWei`), lido na chain.
   */
  async topUpForCashOut(input: {
    clientId: string;
    cashOutId: string;
    reason?: string;
  }): Promise<{ hash: string | null; amountWei: bigint; address: string }> {
    const order = await this.deps.repos.findCashOutChargeByIdForClient(
      input.cashOutId,
      input.clientId,
    );
    if (!order) throw new NotFoundError('cash-out nao encontrado');

    // O cadastro de device e aberto: sem estes tetos, abrir ordens e nunca
    // depositar viraria uma torneira de POL.
    if (await this.deps.repos.hasUnusedCashOutGasTopUp(input.clientId)) {
      throw new ConflictError(
        'ja existe uma reposicao de gas nao usada: deposite ou deixe a ordem expirar',
      );
    }
    const maxPerDay = this.deps.config.gasStation.maxTopUpsPerDay;
    const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1000);
    if ((await this.deps.repos.countCashOutGasTopUpsSince(since)) >= maxPerDay) {
      throw new GasStationError(
        'teto diario de reposicoes de gas atingido',
        'gas_station_daily_cap',
      );
    }

    const reserved = await this.deps.repos.reserveCashOutGasTopUp(
      order.id,
      input.clientId,
      this.now(),
    );
    if (!reserved) {
      throw new ConflictError(
        'reposicao de gas indisponivel para esta ordem (ja reposta, sem aceite ou ja depositada)',
      );
    }

    const address = reserved.originAddress;
    const config = this.stationConfig();
    let sent: { hash: string; amountWei: bigint } | null = null;
    try {
      const balance = await this.chain().balanceOf(config, address);
      const missing = config.maxTopUpWei - balance;
      if (missing > 0n) {
        const result = await this.topUp({
          clientId: input.clientId,
          address,
          chain: 'polygon',
          amountWei: missing,
          reason: input.reason ?? `cashout:${order.id}`,
        });
        sent = { hash: result.hash, amountWei: result.amountWei };
      }
    } catch (err) {
      await this.deps.repos.releaseCashOutGasTopUp(order.id);
      throw err;
    }

    if (!sent) {
      // Nada a enviar: a vaga volta (a carteira ja tem a folga).
      await this.deps.repos.releaseCashOutGasTopUp(order.id);
      return { hash: null, amountWei: 0n, address };
    }
    await this.deps.repos.finishCashOutGasTopUp(order.id, sent.hash);
    return { hash: sent.hash, amountWei: sent.amountWei, address };
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

    const sent = await this.chain().send(config, input.address, input.amountWei);

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
