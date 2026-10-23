import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ADMIN_TOKEN: 'a'.repeat(32),
    DATABASE_URL: 'postgres://motor:senha@localhost:5432/motor',
    DATA_ENCRYPTION_KEY: KEY,
    HD_XPUB: 'xpub6ExemploDeConta',
    ...overrides,
  };
}

describe('P1: guards de configuracao', () => {
  it('aplica defaults seguros e nao exige chave de blind index', () => {
    const config = loadConfig(baseEnv());
    expect(config.server.trustProxy).toBe(false);
    expect(config.chain.tolerancePct).toBe(1);
    expect(config.chain.confirmationsRequired).toBe(10);
    expect(config.crypto.keyring.k1).toBeDefined();
  });

  it('aceita TRUST_PROXY explicito', () => {
    const config = loadConfig(baseEnv({ TRUST_PROXY: '1' }));
    expect(config.server.trustProxy).toBe(true);
  });

  it.each([
    ['PORT', '0'],
    ['CONFIRMATIONS_REQUIRED', '0'],
    ['PAYMENT_TOLERANCE_PCT', '101'],
    ['PAYMENT_TOLERANCE_PCT', '-0.1'],
    ['MONITOR_INTERVAL_MS', '999'],
    ['MONITOR_MAX_TOPICS', '0'],
    ['MONITOR_BLOCK_RANGE', '0'],
    ['MONITOR_ANCHOR_INTERVAL', '0'],
    ['HD_MAX_INDEX', '-1'],
    ['HD_ACCOUNT_INDEX', '-1'],
    ['LINK_TTL_MINUTES', '0'],
  ])('rejeita %s=%s', (nome, valor) => {
    expect(() => loadConfig(baseEnv({ [nome]: valor }))).toThrow(/Configuracao invalida/);
  });

  it('valida wei como string decimal nao-negativa', () => {
    expect(() => loadConfig(baseEnv({ GAS_SPONSOR_AMOUNT_WEI: '1e18' }))).toThrow(
      /Configuracao invalida/,
    );
    expect(() => loadConfig(baseEnv({ GAS_SPONSOR_MIN_BALANCE_WEI: '-1' }))).toThrow(
      /Configuracao invalida/,
    );
    const config = loadConfig(baseEnv({ GAS_SPONSOR_AMOUNT_WEI: '123' }));
    expect(config.gasSponsor.amountWei).toBe(123n);
  });

  it('aplica defaults coerentes de gas: piso menor que o envio', () => {
    const config = loadConfig(baseEnv());
    expect(config.gasSponsor.amountWei).toBe(500_000_000_000_000_000n);
    expect(config.gasSponsor.minBalanceWei).toBe(100_000_000_000_000_000n);
    expect(config.gasSponsor.minBalanceWei).toBeLessThan(config.gasSponsor.amountWei);
  });

  it('valida a chave e os limites do gas sponsor quando configurado', () => {
    const key = `0x${'1'.repeat(64)}`;
    const config = loadConfig(baseEnv({ GAS_SPONSOR_PRIVATE_KEY: key }));
    expect(config.gasSponsor.privateKey).toBe(key);

    expect(() => loadConfig(baseEnv({ GAS_SPONSOR_PRIVATE_KEY: 'sem-0x' }))).toThrow(
      /Configuracao invalida/,
    );
    expect(() =>
      loadConfig(
        baseEnv({ GAS_SPONSOR_PRIVATE_KEY: key, GAS_SPONSOR_AMOUNT_WEI: '0' }),
      ),
    ).toThrow(/maior que zero/);
    expect(() =>
      loadConfig(
        baseEnv({
          GAS_SPONSOR_PRIVATE_KEY: key,
          GAS_SPONSOR_AMOUNT_WEI: '1',
          GAS_SPONSOR_MIN_BALANCE_WEI: '2',
        }),
      ),
    ).toThrow(/nao pode ser maior/);

    const semChave = loadConfig(baseEnv({ GAS_SPONSOR_PRIVATE_KEY: '' }));
    expect(semChave.gasSponsor.privateKey).toBeUndefined();
  });

  it('valida URL/moeda do Ramp e defaults da pagina/liquidacao', () => {
    const config = loadConfig(baseEnv({ RAMP_FIAT_CURRENCY: 'brl' }));
    expect(config.ramp.fiatCurrency).toBe('BRL');
    expect(config.publicBaseUrl).toBe('http://localhost:4578');
    expect(config.links.ttlMinutes).toBe(60);
    expect(config.settlement.days).toBe(1);
    expect(config.webhook.maxAttempts).toBe(6);

    expect(() => loadConfig(baseEnv({ RAMP_BASE_URL: 'javascript:alert(1)' }))).toThrow(
      /Configuracao invalida/,
    );
    expect(() =>
      loadConfig(baseEnv({ RAMP_HOST_LOGO_URL: 'ftp://exemplo/logo.png' })),
    ).toThrow(/Configuracao invalida/);
    expect(() => loadConfig(baseEnv({ PUBLIC_BASE_URL: 'nao-e-url' }))).toThrow(
      /Configuracao invalida/,
    );
    expect(() => loadConfig(baseEnv({ SETTLEMENT_DAYS: '-1' }))).toThrow(
      /Configuracao invalida/,
    );
    expect(loadConfig(baseEnv({ SETTLEMENT_DAYS: '3' })).settlement.days).toBe(3);
  });

  it('exige URL quando o signer e remoto', () => {
    expect(() => loadConfig(baseEnv({ SIGNER_MODE: 'remote' }))).toThrow(/Configuracao invalida/);
  });

  it('em producao exige passphrase do keystore local para o worker', () => {
    expect(() =>
      loadConfig(baseEnv({ NODE_ENV: 'production', SIGNER_MODE: 'local' }), {
        role: 'worker',
      }),
    ).toThrow(/Configuracao invalida/);

    const config = loadConfig(
      baseEnv({
        NODE_ENV: 'production',
        SIGNER_MODE: 'local',
        SIGNER_PASSPHRASE: 'segredo-producao1',
      }),
      { role: 'worker' },
    );
    expect(config.signer.mode).toBe('local');
  });

  it('a API em producao nao exige passphrase nem token do signer', () => {
    const local = loadConfig(
      baseEnv({ NODE_ENV: 'production', SIGNER_MODE: 'local' }),
      { role: 'api' },
    );
    expect(local.signer.mode).toBe('local');
    expect(local.signer.passphrase).toBeUndefined();

    const remoto = loadConfig(
      baseEnv({
        NODE_ENV: 'production',
        SIGNER_MODE: 'remote',
        SIGNER_REMOTE_URL: 'https://signer.exemplo',
      }),
      { role: 'api' },
    );
    expect(remoto.signer.remoteToken).toBeUndefined();
  });

  it('em producao exige https no signer remoto e o token', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: 'production',
          SIGNER_MODE: 'remote',
          SIGNER_REMOTE_URL: 'http://signer.local',
        }),
      ),
    ).toThrow(/Configuracao invalida/);

    const config = loadConfig(
      baseEnv({
        NODE_ENV: 'production',
        SIGNER_MODE: 'remote',
        SIGNER_REMOTE_URL: 'https://signer.local',
        SIGNER_REMOTE_TOKEN: 't'.repeat(16),
      }),
    );
    expect(config.signer.remoteUrl).toBe('https://signer.local');
  });

  it('em producao recusa token de exemplo, senha curta e RPC sem https', () => {
    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: 'production',
          SIGNER_MODE: 'psbt',
          ADMIN_TOKEN: 'troque-este-token-por-um-valor-aleatorio-longo',
        }),
      ),
    ).toThrow(/ADMIN_TOKEN/);

    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: 'production',
          SIGNER_MODE: 'local',
          SIGNER_PASSPHRASE: 'curta-demais',
        }),
      ),
    ).toThrow(/16 caracteres/);

    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: 'production',
          SIGNER_MODE: 'psbt',
          RPC_URL_POLYGON: 'http://rpc.local',
        }),
      ),
    ).toThrow(/https/);
  });
});
