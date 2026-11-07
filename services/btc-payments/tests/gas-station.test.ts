import { describe, expect, it } from 'vitest';
import { GasStationService } from '../src/services/gas-station-service.js';
import { GasStationError } from '../src/adapters/chain/gas-station.js';
import { testConfig } from './helpers.js';
import { silentLogger } from '../src/logger.js';
import { ConflictError, NotFoundError } from '../src/domain/errors.js';

/**
 * A gas station empresta o nativo para a carteira do cliente: sem ela, pagar um
 * Pix com cripto trava para quem so tem a stablecoin.
 *
 * Aqui vao os guardas (endereco, rede, teto, desligada) — o envio de verdade
 * depende da rede e e exercitado na operacao real.
 */
describe('gas station', () => {
  const address = '0xe49FBc85D36B37Ea85895c339aA9044b0D2B7ce6';

  const build = (overrides: Record<string, string> = {}) => {
    const config = testConfig({
      GAS_STATION_ENABLED: 'true',
      GAS_STATION_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
      ...overrides,
    });
    const repos = {
      insertAuditEvent: async () => undefined,
    } as never;
    return new GasStationService({ repos, config, logger: silentLogger });
  };

  it('exige um endereco EVM valido', async () => {
    const service = build();
    await expect(
      service.topUp({ clientId: 'c1', address: '0x123', chain: 'polygon', amountWei: 1n }),
    ).rejects.toThrow(/endereco invalido/);
  });

  it('so repõe em redes com gas station', async () => {
    const service = build();
    await expect(
      service.topUp({ clientId: 'c1', address, chain: 'base', amountWei: 1n }),
    ).rejects.toThrow(/rede sem gas station/);
  });

  it('recusa valor acima do teto (nao e para encher a carteira)', async () => {
    const service = build({ GAS_STATION_MAX_TOPUP_WEI: '1000000000000000' });
    await expect(
      service.topUp({ clientId: 'c1', address, chain: 'polygon', amountWei: 10n ** 18n }),
    ).rejects.toBeInstanceOf(GasStationError);
  });

  it('recusa valor invalido', async () => {
    const service = build();
    await expect(
      service.topUp({ clientId: 'c1', address, chain: 'polygon', amountWei: 0n }),
    ).rejects.toThrow(/valor de reposicao invalido/);
  });

  it('fica desligada sem chave de tesouraria', () => {
    const config = testConfig({ GAS_STATION_ENABLED: 'false' });
    const service = new GasStationService({
      repos: { insertAuditEvent: async () => undefined } as never,
      config,
      logger: silentLogger,
    });
    expect(service.isEnabled()).toBe(false);
  });

  it('exige a chave de tesouraria quando habilitada', () => {
    // Sem a chave, o ambiente nao sobe: uma gas station sem tesouraria
    // prometeria repor gas que nao existe.
    expect(() => testConfig({ GAS_STATION_ENABLED: 'true' })).toThrow(
      /GAS_STATION_PRIVATE_KEY/,
    );
    const config = testConfig({
      GAS_STATION_ENABLED: 'true',
      GAS_STATION_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
    });
    expect(config.gasStation.enabled).toBe(true);
    expect(config.gasStation.maxTopUpWei).toBe(50_000_000_000_000_000n);
  });

  it('reporta a situacao da tesouraria mesmo desligada', async () => {
    const config = testConfig({ GAS_STATION_ENABLED: 'false' });
    const service = new GasStationService({
      repos: { insertAuditEvent: async () => undefined } as never,
      config,
      logger: silentLogger,
    });
    const status = await service.status();
    expect(status.enabled).toBe(false);
    expect(status.minTreasuryWei).toBe(config.gasStation.minTreasuryWei.toString());
  });
});

/**
 * A reposicao publica e sempre amarrada a uma venda do proprio cliente: o
 * cadastro de device e aberto, entao qualquer brecha aqui vira torneira.
 */
describe('gas station por cash-out', () => {
  const ORIGIN = '0xe49fbc85d36b37ea85895c339aa9044b0d2b7ce6';
  const MAX = 50_000_000_000_000_000n;

  type Order = {
    id: string;
    clientId: string;
    status: string;
    depositAddress: string | null;
    txHash: string | null;
    gasToppedUpAt: Date | null;
    gasTopUpTxHash: string | null;
    originAddress: string;
  };

  const build = (opts: { balance?: bigint; perDay?: string; sendFails?: boolean } = {}) => {
    const orders = new Map<string, Order>();
    const sends: { to: string; amountWei: bigint }[] = [];
    const repos = {
      insertAuditEvent: async () => undefined,
      findCashOutChargeByIdForClient: async (id: string, clientId: string) => {
        const o = orders.get(id);
        return o && o.clientId === clientId ? { ...o } : null;
      },
      // Espelha o update condicional do Postgres (sincrono: atomico no teste).
      reserveCashOutGasTopUp: async (id: string, clientId: string, at: Date) => {
        const o = orders.get(id);
        if (
          !o ||
          o.clientId !== clientId ||
          o.status !== 'aguardando_deposito' ||
          !o.depositAddress ||
          o.txHash ||
          o.gasToppedUpAt
        ) {
          return null;
        }
        o.gasToppedUpAt = at;
        return { ...o };
      },
      finishCashOutGasTopUp: async (id: string, hash: string) => {
        orders.get(id)!.gasTopUpTxHash = hash;
      },
      releaseCashOutGasTopUp: async (id: string) => {
        const o = orders.get(id)!;
        o.gasToppedUpAt = null;
        o.gasTopUpTxHash = null;
      },
      countCashOutGasTopUpsSince: async () =>
        [...orders.values()].filter((o) => o.gasTopUpTxHash).length,
      hasUnusedCashOutGasTopUp: async (clientId: string) =>
        [...orders.values()].some(
          (o) =>
            o.clientId === clientId &&
            o.gasTopUpTxHash &&
            !o.txHash &&
            ['criando', 'pendente', 'aguardando_deposito'].includes(o.status),
        ),
    } as never;
    const config = testConfig({
      GAS_STATION_ENABLED: 'true',
      GAS_STATION_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
      ...(opts.perDay ? { GAS_STATION_MAX_TOPUPS_PER_DAY: opts.perDay } : {}),
    });
    const chain = {
      balanceOf: async () => opts.balance ?? 0n,
      send: async (_c: unknown, to: string, amountWei: bigint) => {
        // Cede o turno: duas chamadas concorrentes se intercalam aqui.
        await new Promise((r) => setTimeout(r, 5));
        if (opts.sendFails) throw new Error('rpc caiu');
        sends.push({ to, amountWei });
        return { hash: `0x${String(sends.length).padStart(64, '0')}`, from: '0xtesouraria' };
      },
    };
    const service = new GasStationService({ repos, config, logger: silentLogger, chain });
    const addOrder = (o: Partial<Order> & { id: string }) =>
      orders.set(o.id, {
        clientId: 'c1',
        status: 'aguardando_deposito',
        depositAddress: '0x1111111111111111111111111111111111111111',
        txHash: null,
        gasToppedUpAt: null,
        gasTopUpTxHash: null,
        originAddress: ORIGIN,
        ...o,
      });
    return { service, orders, sends, addOrder };
  };

  it('envia para o origin_address da ordem so o que falta para a folga', async () => {
    const { service, sends, addOrder } = build({ balance: MAX - 1000n });
    addOrder({ id: 'o1' });
    const result = await service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o1' });
    expect(sends).toEqual([{ to: ORIGIN, amountWei: 1000n }]);
    expect(result.amountWei).toBe(1000n);
    expect(result.address).toBe(ORIGIN);
  });

  it('ordem de outro cliente e 404', async () => {
    const { service, addOrder } = build();
    addOrder({ id: 'o1', clientId: 'outro' });
    await expect(
      service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o1' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('uma reposicao por ordem', async () => {
    const { service, sends, addOrder } = build();
    addOrder({ id: 'o1' });
    await service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o1' });
    await expect(
      service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o1' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(sends).toHaveLength(1);
  });

  it('duas chamadas concorrentes geram um envio so', async () => {
    const { service, sends, addOrder } = build();
    addOrder({ id: 'o1' });
    const results = await Promise.allSettled([
      service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o1' }),
      service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o1' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });

  it('recusa ordem sem aceite ou ja depositada', async () => {
    const { service, addOrder } = build();
    addOrder({ id: 'sem-aceite', status: 'pendente', depositAddress: null });
    addOrder({ id: 'depositada', txHash: `0x${'a'.repeat(64)}` });
    await expect(
      service.topUpForCashOut({ clientId: 'c1', cashOutId: 'sem-aceite' }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      service.topUpForCashOut({ clientId: 'c1', cashOutId: 'depositada' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('nao envia nada quando a carteira ja tem a folga (e devolve a vaga)', async () => {
    const { service, sends, orders, addOrder } = build({ balance: MAX });
    addOrder({ id: 'o1' });
    const result = await service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o1' });
    expect(result).toEqual({ hash: null, amountWei: 0n, address: ORIGIN });
    expect(sends).toHaveLength(0);
    expect(orders.get('o1')!.gasToppedUpAt).toBeNull();
  });

  it('envio que falha devolve a vaga', async () => {
    const { service, orders, addOrder } = build({ sendFails: true });
    addOrder({ id: 'o1' });
    await expect(
      service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o1' }),
    ).rejects.toThrow(/rpc caiu/);
    expect(orders.get('o1')!.gasToppedUpAt).toBeNull();
  });

  it('nao repõe uma segunda ordem enquanto o gas da primeira nao foi usado', async () => {
    const { service, sends, addOrder } = build();
    addOrder({ id: 'o1' });
    addOrder({ id: 'o2' });
    await service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o1' });
    await expect(
      service.topUpForCashOut({ clientId: 'c1', cashOutId: 'o2' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(sends).toHaveLength(1);
  });

  it('respeita o teto diario global', async () => {
    const { service, addOrder } = build({ perDay: '1' });
    addOrder({ id: 'o1', clientId: 'a' });
    addOrder({ id: 'o2', clientId: 'b' });
    await service.topUpForCashOut({ clientId: 'a', cashOutId: 'o1' });
    await expect(
      service.topUpForCashOut({ clientId: 'b', cashOutId: 'o2' }),
    ).rejects.toThrow(/teto diario/);
  });
});
