import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ADMIN_TOKEN: 'a'.repeat(32),
    DATABASE_URL: 'postgres://motor:senha@localhost:5432/motor',
    DATA_ENCRYPTION_KEY: KEY,
    DATA_INDEX_KEY: KEY,
    HD_XPUB: 'xpub6ExemploDeConta',
    ...overrides,
  };
}

describe('P1: guards de configuracao', () => {
  it('aplica defaults seguros (trustProxy=false, sem token read-only)', () => {
    const config = loadConfig(baseEnv());
    expect(config.server.trustProxy).toBe(false);
    expect(config.server.readonlyToken).toBeUndefined();
    expect(config.chain.tolerancePct).toBe(1);
    expect(config.chain.confirmationsRequired).toBe(10);
  });

  it('trata READONLY_TOKEN vazio como desabilitado', () => {
    const config = loadConfig(baseEnv({ READONLY_TOKEN: '' }));
    expect(config.server.readonlyToken).toBeUndefined();
  });

  it('aceita TRUST_PROXY explicito e READONLY_TOKEN', () => {
    const config = loadConfig(
      baseEnv({ TRUST_PROXY: '1', READONLY_TOKEN: 'r'.repeat(32) }),
    );
    expect(config.server.trustProxy).toBe(true);
    expect(config.server.readonlyToken).toBe('r'.repeat(32));
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
    ['LINK_TTL_HOURS', '0'],
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

  it('exige URL quando o signer e remoto', () => {
    expect(() => loadConfig(baseEnv({ SIGNER_MODE: 'remote' }))).toThrow(/Configuracao invalida/);
  });

  it('em producao exige passphrase do keystore local', () => {
    expect(() =>
      loadConfig(baseEnv({ NODE_ENV: 'production', SIGNER_MODE: 'local' })),
    ).toThrow(/Configuracao invalida/);

    const config = loadConfig(
      baseEnv({
        NODE_ENV: 'production',
        SIGNER_MODE: 'local',
        SIGNER_PASSPHRASE: 'segredo',
      }),
    );
    expect(config.signer.mode).toBe('local');
  });

  it('em producao exige https no signer remoto', () => {
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
      }),
    );
    expect(config.signer.remoteUrl).toBe('https://signer.local');
  });
});
