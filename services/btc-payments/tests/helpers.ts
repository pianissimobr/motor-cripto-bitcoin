import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { base58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { encryptSecret } from '../src/crypto/cipher.js';
import { sha256Hex } from '../src/crypto/hmac.js';
import type { DbClient } from '../src/db/client.js';
import type { Repositories } from '../src/db/repositories.js';
import type { ApiClient } from '../src/domain/types.js';

export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const coder = base58check((data) =>
  createHash('sha256').update(data).digest(),
);

function withVersion(extended: string, version: number): string {
  const raw = Buffer.from(coder.decode(extended));
  raw.writeUInt32BE(version, 0);
  return coder.encode(raw);
}

export function testTpub(): string {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC));
  return withVersion(root.derive("m/84'/0'/0'").publicExtendedKey, 0x043587cf);
}

export function baseEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ADMIN_TOKEN: 'admin-token-de-teste-123',
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      'postgres://btc:btc@localhost:5434/btc_payments_test',
    DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    BTC_NETWORK: 'regtest',
    BTC_XPUB: testTpub(),
    LNBITS_URL: 'http://localhost:5001',
    LNBITS_API_KEY: 'invoice-key',
    LNBITS_WEBHOOK_TOKEN: 'webhook-token',
    ESPLORA_URL: 'http://localhost:3002',
    SWEEP_ENABLED: 'true',
    COLD_WALLET_ADDRESS: 'bcrt1qnjg0jd8228aq7egyzacy8cys3knf9xvr3v5hfj',
    SIGNER_MODE: 'local',
    SIGNER_PASSPHRASE: 'passphrase-de-teste',
    WEBHOOK_MAX_ATTEMPTS: '2',
    ...overrides,
  };
}

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig(baseEnv(overrides));
}

export async function truncateAll(db: DbClient): Promise<void> {
  await db.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL client_min_messages TO WARNING`);
    await tx.execute(sql`
      TRUNCATE
        subscription_charges,
        subscriptions,
        password_reset_tokens,
        email_verification_tokens,
        sessions,
        merchant_members,
        users,
        reconciliation_runs,
        provider_events,
        ledger_entries,
        ledger_transactions,
        ledger_accounts,
        payouts,
        pix_charges,
        cashout_charges,
        swap_orders,
        conversion_legs,
        conversion_orders,
        fx_quotes,
        fx_rates,
        webhook_events,
        invoices,
        store_keys,
        merchant_pix_banks,
        nuvemshop_payments,
        nuvemshop_stores,
        bling_exports,
        bling_connections,
        onchain_payments,
        onchain_sweeps,
        lightning_payments,
        payment_intents,
        api_nonces,
        api_clients,
        merchant_wallet_state,
        merchant_wallets,
        treasury_wallets,
        hd_addresses,
        hd_wallet_state,
        audit_events
      RESTART IDENTITY CASCADE
    `);
  });
}

export type TestClient = {
  client: ApiClient;
  apiKey: string;
  requestSecret: string;
  webhookSecret: string;
};

export async function createTestClient(
  repos: Repositories,
  config: AppConfig,
  overrides: Partial<{ webhookUrl: string; name: string }> = {},
): Promise<TestClient> {
  const id = randomUUID();
  const apiKey = `mk_btc_live_${randomBytes(16).toString('base64url')}`;
  const requestSecret = randomBytes(32).toString('base64url');
  const webhookSecret = randomBytes(32).toString('base64url');
  const key = config.crypto.keyring[config.crypto.activeKid]!;
  const kid = config.crypto.activeKid;

  const client = await repos.createClient({
    id,
    name: overrides.name ?? 'Cliente de teste',
    apiKeyPrefix: apiKey.slice(0, 20),
    apiKeyHash: sha256Hex(apiKey),
    requestSecretEnc: encryptSecret(requestSecret, key, kid, id),
    webhookUrl: overrides.webhookUrl ?? 'http://localhost:9999/webhook',
    webhookSecretEnc: encryptSecret(webhookSecret, key, kid, id),
  });

  return { client, apiKey, requestSecret, webhookSecret };
}

/**
 * Carteiras Bitcoin do lojista: xpub on-chain (enderecos de cobranca dele) e
 * wallet LNbits (Lightning direto nele). Nos testes o LNbits e falso, entao a
 * Invoice key cifrada e so um marcador.
 */
export async function addBitcoinWallets(
  db: DbClient,
  config: AppConfig,
  merchantId: string,
  rails: { lightning?: boolean; onchain?: boolean } = {},
): Promise<{ lightningWalletId: string | null; btcWalletId: string | null }> {
  const { MerchantWalletService } = await import('../src/services/merchant-wallet-service.js');
  const wallets = new MerchantWalletService(db.db);
  let lightningWalletId: string | null = null;
  let btcWalletId: string | null = null;
  if (rails.onchain !== false) {
    btcWalletId = (
      await wallets.createBtcDeposit({
        merchantId,
        xpub: testTpub(),
        derivationPrefix: config.btc.derivationPrefix,
        network: config.btc.network,
        gapLimit: config.btc.gapLimit,
      })
    ).id;
  }
  if (rails.lightning !== false) {
    lightningWalletId = (
      await wallets.createLightningLnbits({
        merchantId,
        lnbitsUrl: 'http://lnbits.lojista.test',
        secretEnc: 'teste',
      })
    ).id;
  }
  return { lightningWalletId, btcWalletId };
}
