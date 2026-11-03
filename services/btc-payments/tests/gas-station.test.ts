import { describe, expect, it } from 'vitest';
import { GasStationService } from '../src/services/gas-station-service.js';
import { GasStationError } from '../src/adapters/chain/gas-station.js';
import { testConfig } from './helpers.js';
import { silentLogger } from '../src/logger.js';

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
