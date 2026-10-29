import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  ADMIN_TOKEN: 'admin-token-de-teste-123',
  DATABASE_URL: 'postgres://btc:btc@localhost:5433/btc_payments',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  BTC_NETWORK: 'bitcoin',
  BTC_XPUB:
    'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V',
  LNBITS_URL: 'http://localhost:5001',
  LNBITS_API_KEY: 'invoice-key',
  LNBITS_WEBHOOK_TOKEN: 'webhook-token',
  ESPLORA_URL: 'http://localhost:3000',
  SWEEP_ENABLED: 'true',
  COLD_WALLET_ADDRESS: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
  SIGNER_MODE: 'local',
  SIGNER_PASSPHRASE: 'passphrase-de-teste',
};

describe('config', () => {
  it('carrega configuracao valida e normaliza defaults', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.btc.network).toBe('bitcoin');
    expect(config.btc.derivationPrefix).toBe('0');
    expect(config.onchain.confirmations).toBe(1);
    expect(config.lightning.ttlSeconds).toBe(600);
    expect(config.lightning.webhookBaseUrl).toBe('http://localhost:4580');
    expect(config.crypto.activeKid).toBe('k1');
    expect(config.sweep.coldWalletAddress).toBe(
      'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
    );
  });

  it('falha sem BTC_XPUB', () => {
    const env = { ...BASE_ENV };
    delete env.BTC_XPUB;
    expect(() => loadConfig(env)).toThrow();
  });

  it('falha com sweep habilitado sem carteira fria', () => {
    const env = { ...BASE_ENV };
    delete env.COLD_WALLET_ADDRESS;
    expect(() => loadConfig(env)).toThrow(/COLD_WALLET_ADDRESS/);
  });

  it('falha com signer remoto sem URL', () => {
    const env = { ...BASE_ENV, SIGNER_MODE: 'remote' };
    expect(() => loadConfig(env)).toThrow(/SIGNER_REMOTE_URL/);
  });

  it('rejeita prefixo hardened', () => {
    const env = { ...BASE_ENV, BTC_DERIVATION_PREFIX: "0'" };
    expect(() => loadConfig(env)).toThrow();
  });
});
