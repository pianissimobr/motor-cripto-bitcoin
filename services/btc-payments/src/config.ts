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
    BTC_XPUB: z.string().min(1, 'BTC_XPUB obrigatorio (xpub de conta BIP84)'),
    BTC_DERIVATION_PREFIX: z
      .string()
      .default('0')
      .refine((v) => /^\d+(\/\d+)*$/.test(v), {
        message: 'deve ser um caminho relativo nao-hardened, ex.: "0"',
      }),
    BTC_MAX_INDEX: intFromEnv(100_000, 0),
    BTC_GAP_LIMIT: intFromEnv(20, 1),

    INTENT_TTL_SECONDS: intFromEnv(600, 30, 86_400),
    INTENT_GRACE_SECONDS: intFromEnv(86_400, 0),

    ONCHAIN_CONFIRMATIONS: intFromEnv(1, 1),
    ONCHAIN_HIGH_VALUE_SATS: bigintFromEnv('1000000'),
    ONCHAIN_HIGH_VALUE_CONFIRMATIONS: intFromEnv(3, 1),

    LNBITS_URL: httpUrl('LNBITS_URL invalida'),
    LNBITS_API_KEY: z.string().min(1, 'LNBITS_API_KEY obrigatorio'),
    LNBITS_WEBHOOK_TOKEN: z
      .string()
      .min(8, 'LNBITS_WEBHOOK_TOKEN precisa ter ao menos 8 caracteres'),
    LNBITS_WEBHOOK_BASE_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('LNBITS_WEBHOOK_BASE_URL invalida').optional(),
    ),

    ESPLORA_URL: httpUrl('ESPLORA_URL invalida'),
    ESPLORA_TIMEOUT_MS: intFromEnv(10_000, 1_000),

    SWEEP_ENABLED: boolFromEnv(true),
    COLD_WALLET_ADDRESS: z.preprocess(
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

    RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, 1_000),
    RATE_LIMIT_MAX: intFromEnv(120, 1),

    JOBS_LIGHTNING_RECONCILE_MS: intFromEnv(15_000, 1_000),
    JOBS_EXPIRY_POLL_MS: intFromEnv(10_000, 1_000),
    JOBS_ONCHAIN_POLL_MS: intFromEnv(15_000, 1_000),
    JOBS_WEBHOOK_POLL_MS: intFromEnv(10_000, 1_000),
    JOBS_SWEEP_POLL_MS: intFromEnv(30_000, 1_000),
    JOBS_BATCH_SIZE: intFromEnv(50, 1, 1_000),

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
    if (env.SWEEP_ENABLED && !env.COLD_WALLET_ADDRESS) {
      ctx.addIssue({
        code: 'custom',
        path: ['COLD_WALLET_ADDRESS'],
        message: 'obrigatorio quando SWEEP_ENABLED=true',
      });
    }
    if (env.SIGNER_MODE === 'remote' && !env.SIGNER_REMOTE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNER_REMOTE_URL'],
        message: 'obrigatorio quando SIGNER_MODE=remote',
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
    if (env.SIGNER_MODE === 'local' && !env.SIGNER_PASSPHRASE) {
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
  };
  btc: {
    network: BtcNetworkName;
    xpub: string;
    derivationPrefix: string;
    maxIndex: number;
    gapLimit: number;
  };
  onchain: {
    confirmations: number;
    highValueSats: bigint;
    highValueConfirmations: number;
    graceSeconds: number;
  };
  lightning: {
    url: string;
    apiKey: string;
    webhookToken: string;
    webhookBaseUrl: string;
    ttlSeconds: number;
  };
  esplora: {
    url: string;
    timeoutMs: number;
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
    batchSize: number;
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
      xpub: env.BTC_XPUB,
      derivationPrefix: env.BTC_DERIVATION_PREFIX,
      maxIndex: env.BTC_MAX_INDEX,
      gapLimit: env.BTC_GAP_LIMIT,
    },
    onchain: {
      confirmations: env.ONCHAIN_CONFIRMATIONS,
      highValueSats: env.ONCHAIN_HIGH_VALUE_SATS,
      highValueConfirmations: env.ONCHAIN_HIGH_VALUE_CONFIRMATIONS,
      graceSeconds: env.INTENT_GRACE_SECONDS,
    },
    lightning: {
      url: env.LNBITS_URL.replace(/\/+$/, ''),
      apiKey: env.LNBITS_API_KEY,
      webhookToken: env.LNBITS_WEBHOOK_TOKEN,
      webhookBaseUrl: (env.LNBITS_WEBHOOK_BASE_URL ?? env.PUBLIC_BASE_URL).replace(
        /\/+$/,
        '',
      ),
      ttlSeconds: env.INTENT_TTL_SECONDS,
    },
    esplora: {
      url: env.ESPLORA_URL.replace(/\/+$/, ''),
      timeoutMs: env.ESPLORA_TIMEOUT_MS,
    },
    sweep: {
      enabled: env.SWEEP_ENABLED,
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
      batchSize: env.JOBS_BATCH_SIZE,
    },
    alerts: {
      ...(env.ALERT_WEBHOOK_URL ? { webhookUrl: env.ALERT_WEBHOOK_URL } : {}),
      ...(env.ALERT_WEBHOOK_TOKEN ? { token: env.ALERT_WEBHOOK_TOKEN } : {}),
      timeoutMs: 5_000,
    },
    env,
  };
}
