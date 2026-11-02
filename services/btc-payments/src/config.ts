import { createHmac } from 'node:crypto';
import { z } from 'zod';

export const SERVICE_NAME = 'btc-payments';
export const SERVICE_VERSION = '0.1.0';

const boolFromEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === ''
        ? def
        : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
    )
    .pipe(z.boolean());

const intFromEnv = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const bigintFromEnv = (def: string) =>
  z
    .string()
    .default(def)
    .refine((v) => /^\d+$/.test(v), {
      message: 'deve ser um inteiro nao-negativo em sats (string decimal)',
    })
    .transform((v) => BigInt(v));

const floatFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite().positive());

const httpUrl = (message: string) =>
  z
    .string()
    .url(message)
    .refine((value) => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, 'deve usar http(s)');

export const SignerMode = z.enum(['local', 'remote', 'psbt']);
export type SignerMode = z.infer<typeof SignerMode>;

export const BtcNetworkName = z.enum(['bitcoin', 'testnet', 'regtest']);
export type BtcNetworkName = z.infer<typeof BtcNetworkName>;

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intFromEnv(4580, 1, 65_535),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.string().default('info'),
    PUBLIC_BASE_URL: httpUrl('PUBLIC_BASE_URL invalida').default(
      'http://localhost:4580',
    ),
    ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN precisa ter ao menos 16 caracteres'),
    TRUST_PROXY: boolFromEnv(false),
    CORS_ALLOWED_ORIGINS: z.string().default(''),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL obrigatorio'),
    DATABASE_SSL: boolFromEnv(false),
    DATABASE_SSL_CA: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),

    DATA_ENCRYPTION_KEY: z.string().min(1, 'DATA_ENCRYPTION_KEY obrigatorio'),
    KEYRING: z.string().optional(),
    DATA_ACTIVE_KID: z.string().default('k1'),
    DATA_LEGACY_KID: z.string().optional(),

    BTC_NETWORK: BtcNetworkName.default('bitcoin'),
    BTC_XPUB: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1, 'BTC_XPUB obrigatorio (xpub de conta BIP84)').optional(),
    ),
    BTC_DERIVATION_PREFIX: z
      .string()
      .default('0')
      .refine((v) => /^\d+(\/\d+)*$/.test(v), {
        message: 'deve ser um caminho relativo nao-hardened, ex.: "0"',
      }),
    BTC_MAX_INDEX: intFromEnv(100_000, 0),
    // Indice sequencial gravado no banco. O restore varre 0..next_receive_index
    // a partir desse estado. Nao recupera um gap de carteira externa.
    BTC_GAP_LIMIT: intFromEnv(20, 1),

    INTENT_TTL_SECONDS: intFromEnv(600, 30, 86_400),
    INTENT_GRACE_SECONDS: intFromEnv(86_400, 0),
    FX_QUOTE_TTL_SECONDS: intFromEnv(600, 30, 86_400),

    ONCHAIN_ENABLED: boolFromEnv(true),
    ONCHAIN_CONFIRMATIONS: intFromEnv(1, 1),
    ONCHAIN_HIGH_VALUE_SATS: bigintFromEnv('1000000'),
    ONCHAIN_HIGH_VALUE_CONFIRMATIONS: intFromEnv(3, 1),

    LIGHTNING_ENABLED: boolFromEnv(true),
    LNBITS_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('LNBITS_URL invalida').optional(),
    ),
    LNBITS_API_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1, 'LNBITS_API_KEY obrigatorio').optional(),
    ),
    LNBITS_WEBHOOK_TOKEN: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(8, 'LNBITS_WEBHOOK_TOKEN precisa ter ao menos 8 caracteres').optional(),
    ),
    LNBITS_WEBHOOK_BASE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('LNBITS_WEBHOOK_BASE_URL invalida').optional(),
    ),

    ESPLORA_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('ESPLORA_URL invalida').optional(),
    ),
    ESPLORA_TIMEOUT_MS: intFromEnv(10_000, 1_000),

    SWEEP_ENABLED: boolFromEnv(true),
    COLD_WALLET_ADDRESS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    TREASURY_BTC_ADDRESS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    TREASURY_USDC_ADDRESS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    GAS_BASE_ADDRESS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    SWEEP_MIN_SATS: bigintFromEnv('1000'),
    SWEEP_FEE_TARGET_BLOCKS: intFromEnv(6, 1, 1_008),
    SWEEP_FEE_MULTIPLIER: floatFromEnv(1.0),
    SWEEP_MAX_FEE_PCT: floatFromEnv(0.1),
    SWEEP_RBF_AFTER_SECONDS: intFromEnv(600, 60),
    SWEEP_MAX_ATTEMPTS: intFromEnv(3, 1),

    SIGNER_MODE: SignerMode.default('local'),
    SIGNER_KEYSTORE_PATH: z.string().default('./data/keystore.json'),
    SIGNER_PASSPHRASE: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(8).optional(),
    ),
    SIGNER_REMOTE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('SIGNER_REMOTE_URL invalida').optional(),
    ),
    SIGNER_REMOTE_TOKEN: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),

    WEBHOOK_TIMEOUT_MS: intFromEnv(10_000, 1_000),
    WEBHOOK_MAX_ATTEMPTS: intFromEnv(6, 1),

    CONVERSION_ENABLED: boolFromEnv(false),
    THORCHAIN_URLS: z
      .string()
      .default('https://thornode.ninerealms.com,https://thornode.thorswap.net'),
    THORCHAIN_TIMEOUT_MS: intFromEnv(15_000, 1_000),
    CONVERSION_MIN_CONFIRMATIONS: intFromEnv(3, 1),
    CONVERSION_MIN_SATS: bigintFromEnv('10000'),
    CONVERSION_SLIPPAGE_BPS: intFromEnv(100, 0, 5_000),
    CONVERSION_QUOTE_TOLERANCE_BPS: intFromEnv(50, 0, 5_000),
    CONVERSION_MAX_ATTEMPTS: intFromEnv(3, 1),
    TREASURY_BTC_SIGNER_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('TREASURY_BTC_SIGNER_URL invalida').optional(),
    ),
    TREASURY_BTC_SIGNER_TOKEN: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    LNBITS_WITHDRAWAL_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('LNBITS_WITHDRAWAL_URL invalida').optional(),
    ),
    LNBITS_WITHDRAWAL_TOKEN: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),

    PAYOUT_ENABLED: boolFromEnv(false),
    BASE_RPC_URLS: z.string().default('https://mainnet.base.org,https://base-rpc.publicnode.com'),
    BASE_CHAIN_ID: intFromEnv(8453, 1),
    BASE_USDC_ADDRESS: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'BASE_USDC_ADDRESS invalido')
      .default('0x833589fCD6EDB6E08F4C7C32D4f71b54BDA02913'),
    BASE_PAYOUT_PRIVATE_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'BASE_PAYOUT_PRIVATE_KEY invalida').optional(),
    ),
    PAYOUT_HOT_ADDRESS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'PAYOUT_HOT_ADDRESS invalido').optional(),
    ),
    PAYOUT_CONFIRMATIONS: intFromEnv(1, 1),
    PAYOUT_NEW_WALLET_CARE_SECONDS: intFromEnv(86_400, 0),
    PAYOUT_USD_BRL_RATE_CENTS: intFromEnv(540, 1),
    PAYOUT_MIN_GAS_WEI: bigintFromEnv('100000000000000'),
    PAYOUT_SIGNER_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('PAYOUT_SIGNER_URL invalida').optional(),
    ),
    PAYOUT_SIGNER_TOKEN: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    PAYOUT_MAX_ATTEMPTS: intFromEnv(3, 1),

    PIX_ENABLED: boolFromEnv(false),
    LUNIUM_API_URL: httpUrl('LUNIUM_API_URL invalida').default(
      'https://api.luniumpay.com',
    ),
    LUNIUM_API_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    LUNIUM_WEBHOOK_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(8).optional(),
    ),
    LUNIUM_TIMEOUT_MS: intFromEnv(15_000, 1_000),
    PIX_ASSET: z.literal('usdc').default('usdc'),
    PIX_CHAIN: z.literal('base').default('base'),
    PIX_MIN_BRL_CENTS: bigintFromEnv('2500'),
    PIX_MAX_BRL_CENTS: bigintFromEnv('25000000'),
    PIX_VERIFY_SETTLEMENT_TX: boolFromEnv(true),

    RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, 1_000),
    RATE_LIMIT_MAX: intFromEnv(120, 1),

    SESSION_TTL_SECONDS: intFromEnv(604_800, 600, 31_536_000),

    JOBS_LIGHTNING_RECONCILE_MS: intFromEnv(15_000, 1_000),
    JOBS_EXPIRY_POLL_MS: intFromEnv(10_000, 1_000),
    JOBS_ONCHAIN_POLL_MS: intFromEnv(15_000, 1_000),
    JOBS_WEBHOOK_POLL_MS: intFromEnv(10_000, 1_000),
    JOBS_SWEEP_POLL_MS: intFromEnv(30_000, 1_000),
    JOBS_CONVERSION_POLL_MS: intFromEnv(30_000, 1_000),
    JOBS_PAYOUT_POLL_MS: intFromEnv(30_000, 1_000),
    JOBS_PIX_POLL_MS: intFromEnv(30_000, 1_000),
    JOBS_SUBSCRIPTION_MS: intFromEnv(60_000, 1_000),
    JOBS_RECONCILIATION_MS: intFromEnv(86_400_000, 60_000),
    JOBS_BATCH_SIZE: intFromEnv(50, 1, 1_000),

    METRICS_TOKEN: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(8, 'METRICS_TOKEN precisa ter ao menos 8 caracteres').optional(),
    ),

    ALERT_WEBHOOK_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('ALERT_WEBHOOK_URL invalida').optional(),
    ),
    ALERT_WEBHOOK_TOKEN: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
  })
  .superRefine((env, ctx) => {
    if (!env.LIGHTNING_ENABLED && !env.ONCHAIN_ENABLED && !env.PIX_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['PIX_ENABLED'],
        message:
          'habilite ao menos um motor: LIGHTNING_ENABLED, ONCHAIN_ENABLED ou PIX_ENABLED',
      });
    }
    if (env.LIGHTNING_ENABLED) {
      if (!env.LNBITS_URL) {
        ctx.addIssue({ code: 'custom', path: ['LNBITS_URL'], message: 'obrigatorio quando LIGHTNING_ENABLED=true' });
      }
      if (!env.LNBITS_API_KEY) {
        ctx.addIssue({ code: 'custom', path: ['LNBITS_API_KEY'], message: 'obrigatorio quando LIGHTNING_ENABLED=true' });
      }
      if (!env.LNBITS_WEBHOOK_TOKEN) {
        ctx.addIssue({ code: 'custom', path: ['LNBITS_WEBHOOK_TOKEN'], message: 'obrigatorio quando LIGHTNING_ENABLED=true' });
      }
    }
    if (env.ONCHAIN_ENABLED) {
      if (!env.BTC_XPUB) {
        ctx.addIssue({ code: 'custom', path: ['BTC_XPUB'], message: 'obrigatorio quando ONCHAIN_ENABLED=true' });
      }
      if (!env.ESPLORA_URL) {
        ctx.addIssue({ code: 'custom', path: ['ESPLORA_URL'], message: 'obrigatorio quando ONCHAIN_ENABLED=true' });
      }
    }
    if (env.ONCHAIN_ENABLED && env.SWEEP_ENABLED && !env.COLD_WALLET_ADDRESS && !env.TREASURY_BTC_ADDRESS) {
      ctx.addIssue({
        code: 'custom',
        path: ['COLD_WALLET_ADDRESS'],
        message: 'COLD_WALLET_ADDRESS ou TREASURY_BTC_ADDRESS obrigatorio quando SWEEP_ENABLED=true',
      });
    }
    if (env.SIGNER_MODE === 'remote' && !env.SIGNER_REMOTE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNER_REMOTE_URL'],
        message: 'obrigatorio quando SIGNER_MODE=remote',
      });
    }
    if (env.PIX_ENABLED && !env.LUNIUM_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['LUNIUM_API_KEY'],
        message: 'obrigatorio quando PIX_ENABLED=true',
      });
    }
    if (env.PIX_ENABLED && !env.LUNIUM_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['LUNIUM_WEBHOOK_SECRET'],
        message: 'obrigatorio quando PIX_ENABLED=true',
      });
    }
    if (
      env.PIX_ENABLED &&
      !env.TREASURY_USDC_ADDRESS &&
      !env.PAYOUT_HOT_ADDRESS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['TREASURY_USDC_ADDRESS'],
        message:
          'TREASURY_USDC_ADDRESS ou PAYOUT_HOT_ADDRESS obrigatorio quando PIX_ENABLED=true',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.ADMIN_TOKEN.length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_TOKEN'],
        message: 'em producao precisa ter ao menos 32 caracteres',
      });
    }
    if (!env.METRICS_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['METRICS_TOKEN'],
        message: 'em producao a rota /metrics nao pode ficar aberta',
      });
    }
    if (env.ONCHAIN_ENABLED && env.SWEEP_ENABLED && env.SIGNER_MODE === 'local' && !env.SIGNER_PASSPHRASE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNER_PASSPHRASE'],
        message: 'obrigatoria em producao quando SIGNER_MODE=local',
      });
    }
    if (
      env.SIGNER_MODE === 'remote' &&
      env.SIGNER_REMOTE_URL &&
      !env.SIGNER_REMOTE_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNER_REMOTE_URL'],
        message: 'precisa ser https em producao',
      });
    }
    if (env.SIGNER_MODE === 'remote' && !env.SIGNER_REMOTE_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNER_REMOTE_TOKEN'],
        message: 'obrigatorio em producao quando SIGNER_MODE=remote',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export type AppConfig = {
  service: {
    name: typeof SERVICE_NAME;
    version: string;
    isProduction: boolean;
    publicBaseUrl: string;
  };
  server: {
    port: number;
    host: string;
    logLevel: string;
    adminToken: string;
    trustProxy: boolean;
    corsAllowedOrigins: string[];
    rateLimitWindowMs: number;
    rateLimitMax: number;
    sessionTtlSeconds: number;
  };
  database: {
    url: string;
    ssl: false | { ca?: string };
  };
  crypto: {
    keyring: Record<string, Buffer>;
    activeKid: string;
    legacyKid: string;
    dataKey: Buffer;
    payerTaxBlindKey: Buffer;
  };
  btc: {
    network: BtcNetworkName;
    xpub: string;
    derivationPrefix: string;
    maxIndex: number;
    gapLimit: number;
  };
  fx: {
    quoteTtlSeconds: number;
  };
  onchain: {
    enabled: boolean;
    confirmations: number;
    highValueSats: bigint;
    highValueConfirmations: number;
    graceSeconds: number;
  };
  lightning: {
    enabled: boolean;
    url?: string;
    apiKey?: string;
    webhookToken?: string;
    webhookBaseUrl: string;
    ttlSeconds: number;
  };
  esplora: {
    url?: string;
    timeoutMs: number;
  };
  treasury: {
    btcAddress?: string;
    usdcBaseAddress?: string;
    gasBaseAddress?: string;
  };
  sweep: {
    enabled: boolean;
    coldWalletAddress?: string;
    minSats: bigint;
    feeTargetBlocks: number;
    feeMultiplier: number;
    maxFeePct: number;
    rbfAfterSeconds: number;
    maxAttempts: number;
  };
  conversion: {
    enabled: boolean;
    thorchainUrls: string[];
    timeoutMs: number;
    minConfirmations: number;
    minSats: bigint;
    slippageBps: number;
    quoteToleranceBps: number;
    maxAttempts: number;
    treasuryBtcSignerUrl?: string;
    treasuryBtcSignerToken?: string;
    lnbitsWithdrawalUrl?: string;
    lnbitsWithdrawalToken?: string;
  };
  payout: {
    enabled: boolean;
    baseRpcUrls: string[];
    baseChainId: number;
    usdcAddress: string;
    privateKey?: string;
    hotAddress?: string;
    confirmations: number;
    newWalletCareSeconds: number;
    maxAttempts: number;
    usdBrlCents: bigint;
    minGasWei: bigint;
    signerUrl?: string;
    signerToken?: string;
  };
  pix: {
    enabled: boolean;
    luniumApiUrl: string;
    luniumApiKey?: string;
    luniumWebhookSecret?: string;
    timeoutMs: number;
    asset: 'usdc';
    chain: 'base';
    destinationAddress?: string;
    minBrlCents: bigint;
    maxBrlCents: bigint;
    verifySettlementTx: boolean;
  };
  signer: {
    mode: SignerMode;
    keystorePath: string;
    passphrase?: string;
    remoteUrl?: string;
    remoteToken?: string;
  };
  webhook: {
    timeoutMs: number;
    maxAttempts: number;
  };
  jobs: {
    lightningReconcileMs: number;
    expiryPollMs: number;
    onchainPollMs: number;
    webhookPollMs: number;
    sweepPollMs: number;
    conversionPollMs: number;
    payoutPollMs: number;
    pixPollMs: number;
    subscriptionMs: number;
    reconciliationMs: number;
    batchSize: number;
  };
  metrics: {
    token?: string;
  };
  alerts: {
    webhookUrl?: string;
    token?: string;
    timeoutMs: number;
  };
  env: Env;
};

function decodeKey(base64: string, name: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(base64, 'base64');
  } catch {
    throw new Error(`${name} nao e base64 valido`);
  }
  if (key.length !== 32) {
    throw new Error(`${name} precisa decodificar para exatamente 32 bytes`);
  }
  return key;
}

/**
 * Deriva uma chave dedicada para blind index a partir da chave mestre de
 * cifragem. A derivacao usa o dominio como HMAC key e a chave mestre como
 * entrada, separando o indice reversivel do segredo de cifragem principal.
 */
function deriveBlindKey(master: Buffer, domain: string): Buffer {
  return createHmac('sha256', domain).update(master).digest();
}

function buildCrypto(env: Env): AppConfig['crypto'] {
  let keyring: Record<string, Buffer>;
  if (env.KEYRING && env.KEYRING.trim().length > 0) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(env.KEYRING) as Record<string, string>;
    } catch {
      throw new Error(
        'KEYRING precisa ser JSON: { "k1": "<base64 32 bytes>", "k2": "<base64 32 bytes>" }',
      );
    }
    keyring = {};
    for (const [kid, value] of Object.entries(parsed)) {
      keyring[kid] = decodeKey(value, `KEYRING.${kid}`);
    }
  } else {
    keyring = { k1: decodeKey(env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY') };
  }

  const activeKid = env.DATA_ACTIVE_KID;
  if (!keyring[activeKid]) {
    throw new Error(
      `DATA_ACTIVE_KID="${activeKid}" nao existe no keyring (disponiveis: ${Object.keys(keyring).join(', ')})`,
    );
  }
  const legacyKid = env.DATA_LEGACY_KID ?? Object.keys(keyring)[0]!;
  if (!keyring[legacyKid]) {
    throw new Error(`DATA_LEGACY_KID="${legacyKid}" nao existe no keyring`);
  }

  return {
    keyring,
    activeKid,
    legacyKid,
    dataKey: keyring[legacyKid]!,
    payerTaxBlindKey: deriveBlindKey(keyring[legacyKid]!, 'btc-payments/payer-tax/v1'),
  };
}

function buildCorsOrigins(env: Env): string[] {
  if (env.CORS_ALLOWED_ORIGINS.trim().length > 0) {
    return env.CORS_ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }
  return [new URL(env.PUBLIC_BASE_URL).origin];
}

/**
 * Valida o ambiente e falha cedo. Nenhum segredo e derivado para log.
 */
export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = EnvSchema.parse(raw);
  const crypto = buildCrypto(env);

  if (env.NODE_ENV === 'production') {
    for (const [kid, key] of Object.entries(crypto.keyring)) {
      if (key.equals(Buffer.alloc(32))) {
        throw new Error(
          `chave de cifragem "${kid}" e fraca (todos os bytes zero). Gere com: openssl rand -base64 32`,
        );
      }
    }
  }

  return {
    service: {
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
      isProduction: env.NODE_ENV === 'production',
      publicBaseUrl: env.PUBLIC_BASE_URL,
    },
    server: {
      port: env.PORT,
      host: env.HOST,
      logLevel: env.LOG_LEVEL,
      adminToken: env.ADMIN_TOKEN,
      trustProxy: env.TRUST_PROXY,
      corsAllowedOrigins: buildCorsOrigins(env),
      rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
      rateLimitMax: env.RATE_LIMIT_MAX,
      sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    },
    database: {
      url: env.DATABASE_URL,
      ssl: env.DATABASE_SSL
        ? env.DATABASE_SSL_CA
          ? { ca: env.DATABASE_SSL_CA }
          : {}
        : false,
    },
    crypto,
    btc: {
      network: env.BTC_NETWORK,
      xpub: env.BTC_XPUB ?? '',
      derivationPrefix: env.BTC_DERIVATION_PREFIX,
      maxIndex: env.BTC_MAX_INDEX,
      gapLimit: env.BTC_GAP_LIMIT,
    },
    fx: {
      quoteTtlSeconds: env.FX_QUOTE_TTL_SECONDS,
    },
    onchain: {
      enabled: env.ONCHAIN_ENABLED,
      confirmations: env.ONCHAIN_CONFIRMATIONS,
      highValueSats: env.ONCHAIN_HIGH_VALUE_SATS,
      highValueConfirmations: env.ONCHAIN_HIGH_VALUE_CONFIRMATIONS,
      graceSeconds: env.INTENT_GRACE_SECONDS,
    },
    lightning: {
      enabled: env.LIGHTNING_ENABLED,
      ...(env.LNBITS_URL ? { url: env.LNBITS_URL.replace(/\+$/, '') } : {}),
      ...(env.LNBITS_API_KEY ? { apiKey: env.LNBITS_API_KEY } : {}),
      ...(env.LNBITS_WEBHOOK_TOKEN
        ? { webhookToken: env.LNBITS_WEBHOOK_TOKEN }
        : {}),
      webhookBaseUrl: (env.LNBITS_WEBHOOK_BASE_URL ?? env.PUBLIC_BASE_URL).replace(
        /\/+$/,
        '',
      ),
      ttlSeconds: env.INTENT_TTL_SECONDS,
    },
    esplora: {
      ...(env.ESPLORA_URL ? { url: env.ESPLORA_URL.replace(/\/+$/, '') } : {}),
      timeoutMs: env.ESPLORA_TIMEOUT_MS,
    },
    treasury: {
      ...(env.TREASURY_BTC_ADDRESS
        ? { btcAddress: env.TREASURY_BTC_ADDRESS }
        : {}),
      ...(env.TREASURY_USDC_ADDRESS
        ? { usdcBaseAddress: env.TREASURY_USDC_ADDRESS }
        : {}),
      ...(env.GAS_BASE_ADDRESS ? { gasBaseAddress: env.GAS_BASE_ADDRESS } : {}),
    },
    sweep: {
      enabled: env.SWEEP_ENABLED && env.ONCHAIN_ENABLED,
      ...(env.COLD_WALLET_ADDRESS
        ? { coldWalletAddress: env.COLD_WALLET_ADDRESS }
        : {}),
      minSats: env.SWEEP_MIN_SATS,
      feeTargetBlocks: env.SWEEP_FEE_TARGET_BLOCKS,
      feeMultiplier: env.SWEEP_FEE_MULTIPLIER,
      maxFeePct: env.SWEEP_MAX_FEE_PCT,
      rbfAfterSeconds: env.SWEEP_RBF_AFTER_SECONDS,
      maxAttempts: env.SWEEP_MAX_ATTEMPTS,
    },
    conversion: {
      enabled: env.CONVERSION_ENABLED,
      thorchainUrls: env.THORCHAIN_URLS.split(',')
        .map((url) => url.trim().replace(/\/+$/, ''))
        .filter((url) => url.length > 0),
      timeoutMs: env.THORCHAIN_TIMEOUT_MS,
      minConfirmations: env.CONVERSION_MIN_CONFIRMATIONS,
      minSats: env.CONVERSION_MIN_SATS,
      slippageBps: env.CONVERSION_SLIPPAGE_BPS,
      quoteToleranceBps: env.CONVERSION_QUOTE_TOLERANCE_BPS,
      maxAttempts: env.CONVERSION_MAX_ATTEMPTS,
      ...(env.TREASURY_BTC_SIGNER_URL
        ? { treasuryBtcSignerUrl: env.TREASURY_BTC_SIGNER_URL.replace(/\/+$/, '') }
        : {}),
      ...(env.TREASURY_BTC_SIGNER_TOKEN
        ? { treasuryBtcSignerToken: env.TREASURY_BTC_SIGNER_TOKEN }
        : {}),
      ...(env.LNBITS_WITHDRAWAL_URL
        ? { lnbitsWithdrawalUrl: env.LNBITS_WITHDRAWAL_URL.replace(/\/+$/, '') }
        : {}),
      ...(env.LNBITS_WITHDRAWAL_TOKEN
        ? { lnbitsWithdrawalToken: env.LNBITS_WITHDRAWAL_TOKEN }
        : {}),
    },
    payout: {
      enabled: env.PAYOUT_ENABLED,
      baseRpcUrls: env.BASE_RPC_URLS.split(',')
        .map((url) => url.trim().replace(/\/+$/, ''))
        .filter((url) => url.length > 0),
      baseChainId: env.BASE_CHAIN_ID,
      usdcAddress: env.BASE_USDC_ADDRESS,
      ...(env.BASE_PAYOUT_PRIVATE_KEY
        ? { privateKey: env.BASE_PAYOUT_PRIVATE_KEY }
        : {}),
      ...(env.PAYOUT_HOT_ADDRESS ? { hotAddress: env.PAYOUT_HOT_ADDRESS } : {}),
      confirmations: env.PAYOUT_CONFIRMATIONS,
      newWalletCareSeconds: env.PAYOUT_NEW_WALLET_CARE_SECONDS,
      maxAttempts: env.PAYOUT_MAX_ATTEMPTS,
      usdBrlCents: BigInt(env.PAYOUT_USD_BRL_RATE_CENTS),
      minGasWei: env.PAYOUT_MIN_GAS_WEI,
      ...(env.PAYOUT_SIGNER_URL
        ? { signerUrl: env.PAYOUT_SIGNER_URL.replace(/\/+$/, '') }
        : {}),
      ...(env.PAYOUT_SIGNER_TOKEN
        ? { signerToken: env.PAYOUT_SIGNER_TOKEN }
        : {}),
    },
    pix: {
      enabled: env.PIX_ENABLED,
      luniumApiUrl: env.LUNIUM_API_URL.replace(/\/+$/, ''),
      ...(env.LUNIUM_API_KEY ? { luniumApiKey: env.LUNIUM_API_KEY } : {}),
      ...(env.LUNIUM_WEBHOOK_SECRET
        ? { luniumWebhookSecret: env.LUNIUM_WEBHOOK_SECRET }
        : {}),
      timeoutMs: env.LUNIUM_TIMEOUT_MS,
      asset: env.PIX_ASSET,
      chain: env.PIX_CHAIN,
      ...(env.TREASURY_USDC_ADDRESS
        ? { destinationAddress: env.TREASURY_USDC_ADDRESS }
        : env.PAYOUT_HOT_ADDRESS
          ? { destinationAddress: env.PAYOUT_HOT_ADDRESS }
          : {}),
      minBrlCents: env.PIX_MIN_BRL_CENTS,
      maxBrlCents: env.PIX_MAX_BRL_CENTS,
      verifySettlementTx: env.PIX_VERIFY_SETTLEMENT_TX,
    },
    signer: {
      mode: env.SIGNER_MODE,
      keystorePath: env.SIGNER_KEYSTORE_PATH,
      ...(env.SIGNER_PASSPHRASE ? { passphrase: env.SIGNER_PASSPHRASE } : {}),
      ...(env.SIGNER_REMOTE_URL ? { remoteUrl: env.SIGNER_REMOTE_URL } : {}),
      ...(env.SIGNER_REMOTE_TOKEN
        ? { remoteToken: env.SIGNER_REMOTE_TOKEN }
        : {}),
    },
    webhook: {
      timeoutMs: env.WEBHOOK_TIMEOUT_MS,
      maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    },
    jobs: {
      lightningReconcileMs: env.JOBS_LIGHTNING_RECONCILE_MS,
      expiryPollMs: env.JOBS_EXPIRY_POLL_MS,
      onchainPollMs: env.JOBS_ONCHAIN_POLL_MS,
      webhookPollMs: env.JOBS_WEBHOOK_POLL_MS,
      sweepPollMs: env.JOBS_SWEEP_POLL_MS,
      conversionPollMs: env.JOBS_CONVERSION_POLL_MS,
      payoutPollMs: env.JOBS_PAYOUT_POLL_MS,
      pixPollMs: env.JOBS_PIX_POLL_MS,
      subscriptionMs: env.JOBS_SUBSCRIPTION_MS,
      reconciliationMs: env.JOBS_RECONCILIATION_MS,
      batchSize: env.JOBS_BATCH_SIZE,
    },
    metrics: {
      ...(env.METRICS_TOKEN ? { token: env.METRICS_TOKEN } : {}),
    },
    alerts: {
      ...(env.ALERT_WEBHOOK_URL ? { webhookUrl: env.ALERT_WEBHOOK_URL } : {}),
      ...(env.ALERT_WEBHOOK_TOKEN ? { token: env.ALERT_WEBHOOK_TOKEN } : {}),
      timeoutMs: 5_000,
    },
    env,
  };
}
