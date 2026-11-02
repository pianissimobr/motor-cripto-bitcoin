import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  ADMIN_TOKEN: 'admin-token-de-teste-123',
  DATABASE_URL: 'postgres://btc:btc@localhost:5433/btc_payments',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  BTC_NETWORK: 'bitcoin',
  LNBITS_WEBHOOK_TOKEN: 'webhook-token',
  ESPLORA_URL: 'http://localhost:3000',
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
  });

  it('nao exige carteira da plataforma: o Bitcoin vai para as carteiras dos lojistas', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.lightning.enabled).toBe(true);
    expect(config.onchain.enabled).toBe(true);
  });

  it('on-chain exige ESPLORA_URL para provar os depositos', () => {
    const env = { ...BASE_ENV };
    delete env.ESPLORA_URL;
    expect(() => loadConfig(env)).toThrow(/ESPLORA_URL/);
  });

  it('Lightning exige o token do webhook de entrada', () => {
    const env = { ...BASE_ENV };
    delete env.LNBITS_WEBHOOK_TOKEN;
    expect(() => loadConfig(env)).toThrow(/LNBITS_WEBHOOK_TOKEN/);
  });

  it('PIX exige credenciais da Lunium, mas nenhuma carteira da plataforma', () => {
    expect(() => loadConfig({ ...BASE_ENV, PIX_ENABLED: 'true' })).toThrow(/LUNIUM_API_KEY/);
    const config = loadConfig({
      ...BASE_ENV,
      PIX_ENABLED: 'true',
      LUNIUM_API_KEY: 'lun_test_x',
      LUNIUM_WEBHOOK_SECRET: 'segredo-123',
    });
    expect(config.pix.enabled).toBe(true);
  });

  it('rejeita prefixo hardened', () => {
    const env = { ...BASE_ENV, BTC_DERIVATION_PREFIX: "0'" };
    expect(() => loadConfig(env)).toThrow();
  });
});
