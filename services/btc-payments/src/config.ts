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
    BTC_DERIVATION_PREFIX: z
      .string()
      .default('0')
      .refine((v) => /^\d+(\/\d+)*$/.test(v), {
        message: 'deve ser um caminho relativo nao-hardened, ex.: "0"',
      }),
    BTC_MAX_INDEX: intFromEnv(100_000, 0),
    // Indice sequencial gravado no banco. O restore varre 0..next_receive_index
    // a partir desse estado. Nao recupera um gap de carteira externa.
    // Enderecos seguidos sem uso que a carteira do lojista precisa enxergar.
    // O lojista configura o mesmo gap limit na carteira dele (ex.: 1000).
    BTC_GAP_LIMIT: intFromEnv(1000, 1, 100_000),

    INTENT_TTL_SECONDS: intFromEnv(600, 30, 86_400),
    INTENT_GRACE_SECONDS: intFromEnv(86_400, 0),
    FX_QUOTE_TTL_SECONDS: intFromEnv(600, 30, 86_400),

    ONCHAIN_ENABLED: boolFromEnv(true),
    ONCHAIN_CONFIRMATIONS: intFromEnv(1, 1),
    ONCHAIN_HIGH_VALUE_SATS: bigintFromEnv('1000000'),
    ONCHAIN_HIGH_VALUE_CONFIRMATIONS: intFromEnv(3, 1),

    LIGHTNING_ENABLED: boolFromEnv(true),
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

    WEBHOOK_TIMEOUT_MS: intFromEnv(10_000, 1_000),
    WEBHOOK_MAX_ATTEMPTS: intFromEnv(6, 1),

    BASE_RPC_URLS: z.string().default('https://mainnet.base.org,https://base-rpc.publicnode.com'),
    BASE_CHAIN_ID: intFromEnv(8453, 1),
    BASE_USDC_ADDRESS: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, 'BASE_USDC_ADDRESS invalido')
      .default('0x833589fCD6EDB6E08F4C7C32D4f71b54BDA02913'),

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
    // A Lunium aceita 60 req/min por chave. O motor fica abaixo do teto para
    // sobrar folga e reage a 429 reduzindo o limite efetivo.
    // `api` e `worker` sao processos separados: cada um segura a sua fatia
    // (API = chamadas interativas, worker = reconciliacao) e a soma das duas
    // nao pode passar do total.
    LUNIUM_RATE_LIMIT_MAX: intFromEnv(50, 1, 60),
    LUNIUM_RATE_LIMIT_API_MAX: intFromEnv(20, 1, 60),
    LUNIUM_RATE_LIMIT_WORKER_MAX: intFromEnv(25, 1, 60),
    LUNIUM_RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, 1_000),
    LUNIUM_RATE_LIMIT_MAX_QUEUE: intFromEnv(100, 1, 1_000),
    // Catalogo muda raremente; limites do pagador mudam por uso.
    LUNIUM_CATALOG_CACHE_MS: intFromEnv(300_000, 0),
    LUNIUM_LIMITS_CACHE_MS: intFromEnv(20_000, 0),
    PIX_ASSET: z.literal('usdc').default('usdc'),
    PIX_CHAIN: z.literal('base').default('base'),
    PIX_MIN_BRL_CENTS: bigintFromEnv('2500'),
    PIX_MAX_BRL_CENTS: bigintFromEnv('25000000'),
    PIX_VERIFY_SETTLEMENT_TX: boolFromEnv(true),

    RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, 1_000),
    RATE_LIMIT_MAX: intFromEnv(120, 1),

    SESSION_TTL_SECONDS: intFromEnv(604_800, 600, 31_536_000),

    // authO (perfil issuer): codigos por e-mail e anti-robo ALTCHA do portal.
    AUTHO_ISSUER_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('AUTHO_ISSUER_URL invalida').optional(),
    ),
    AUTHO_TENANT: z.string().trim().min(1).default('motor'),
    AUTHO_ISSUER_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(32, 'AUTHO_ISSUER_SECRET precisa ter ao menos 32 caracteres').optional(),
    ),

    JOBS_LIGHTNING_RECONCILE_MS: intFromEnv(15_000, 1_000),
    JOBS_EXPIRY_POLL_MS: intFromEnv(10_000, 1_000),
    JOBS_ONCHAIN_POLL_MS: intFromEnv(15_000, 1_000),
    JOBS_WEBHOOK_POLL_MS: intFromEnv(10_000, 1_000),
    JOBS_PIX_POLL_MS: intFromEnv(30_000, 1_000),
    JOBS_PIX_BATCH_SIZE: intFromEnv(30, 1, 1_000),
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

    // --- E-mail ---
    // smtp = relay configurado; noop = nada sai (so desenvolvimento).
    EMAIL_SENDER: z.enum(['smtp', 'noop']).default('noop'),
    EMAIL_FROM: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(3).optional(),
    ),
    SMTP_HOST: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    SMTP_PORT: intFromEnv(587, 1, 65_535),
    SMTP_SECURE: boolFromEnv(false),
    SMTP_STARTTLS: boolFromEnv(true),
    SMTP_USER: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    SMTP_PASS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    SMTP_TIMEOUT_MS: intFromEnv(15_000, 1_000),
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
      if (!env.LNBITS_WEBHOOK_TOKEN) {
        ctx.addIssue({ code: 'custom', path: ['LNBITS_WEBHOOK_TOKEN'], message: 'obrigatorio quando LIGHTNING_ENABLED=true' });
      }
    }
    if (env.ONCHAIN_ENABLED) {
      if (!env.ESPLORA_URL) {
        ctx.addIssue({ code: 'custom', path: ['ESPLORA_URL'], message: 'obrigatorio quando ONCHAIN_ENABLED=true' });
      }
    }
    if (env.AUTHO_ISSUER_URL && !env.AUTHO_ISSUER_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTHO_ISSUER_SECRET'],
        message: 'obrigatorio quando AUTHO_ISSUER_URL esta definido',
      });
    }
    if (env.EMAIL_SENDER === 'smtp') {
      if (!env.SMTP_HOST) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_HOST'],
          message: 'obrigatorio quando EMAIL_SENDER=smtp',
        });
      }
      if (!env.EMAIL_FROM) {
        ctx.addIssue({
          code: 'custom',
          path: ['EMAIL_FROM'],
          message: 'obrigatorio quando EMAIL_SENDER=smtp',
        });
      }
      if (!env.SMTP_USER && env.SMTP_PASS) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_USER'],
          message: 'SMTP_PASS exige SMTP_USER',
        });
      }
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
      env.LUNIUM_RATE_LIMIT_API_MAX + env.LUNIUM_RATE_LIMIT_WORKER_MAX >
      env.LUNIUM_RATE_LIMIT_MAX
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['LUNIUM_RATE_LIMIT_WORKER_MAX'],
        message:
          'LUNIUM_RATE_LIMIT_API_MAX + LUNIUM_RATE_LIMIT_WORKER_MAX nao pode passar de LUNIUM_RATE_LIMIT_MAX',
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
    webhookToken?: string;
    webhookBaseUrl: string;
    ttlSeconds: number;
  };
  esplora: {
    url?: string;
    timeoutMs: number;
  };
  base: {
    rpcUrls: string[];
    chainId: number;
    usdcAddress: string;
  };
  pix: {
    enabled: boolean;
    luniumApiUrl: string;
    luniumApiKey?: string;
    luniumWebhookSecret?: string;
    timeoutMs: number;
    asset: 'usdc';
    chain: 'base';
    minBrlCents: bigint;
    maxBrlCents: bigint;
    verifySettlementTx: boolean;
    rateLimit: {
      totalMax: number;
      apiMax: number;
      workerMax: number;
      windowMs: number;
      maxQueue: number;
    };
    catalogCacheMs: number;
    limitsCacheMs: number;
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
    pixPollMs: number;
    pixBatchSize: number;
    subscriptionMs: number;
    reconciliationMs: number;
    batchSize: number;
  };
  metrics: {
    token?: string;
  };
  autho?: {
    url: string;
    tenant: string;
    secret: string;
  };
  alerts: {
    webhookUrl?: string;
    token?: string;
    timeoutMs: number;
  };
  email: {
    sender: 'smtp' | 'noop';
    from?: string;
    smtp?: {
      host: string;
      port: number;
      secure: boolean;
      starttls: boolean;
      user?: string;
      pass?: string;
      timeoutMs: number;
    };
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
    base: {
      rpcUrls: env.BASE_RPC_URLS.split(',')
        .map((url) => url.trim().replace(/\/+$/, ''))
        .filter((url) => url.length > 0),
      chainId: env.BASE_CHAIN_ID,
      usdcAddress: env.BASE_USDC_ADDRESS,
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
      minBrlCents: env.PIX_MIN_BRL_CENTS,
      maxBrlCents: env.PIX_MAX_BRL_CENTS,
      verifySettlementTx: env.PIX_VERIFY_SETTLEMENT_TX,
      rateLimit: {
        totalMax: env.LUNIUM_RATE_LIMIT_MAX,
        apiMax: env.LUNIUM_RATE_LIMIT_API_MAX,
        workerMax: env.LUNIUM_RATE_LIMIT_WORKER_MAX,
        windowMs: env.LUNIUM_RATE_LIMIT_WINDOW_MS,
        maxQueue: env.LUNIUM_RATE_LIMIT_MAX_QUEUE,
      },
      catalogCacheMs: env.LUNIUM_CATALOG_CACHE_MS,
      limitsCacheMs: env.LUNIUM_LIMITS_CACHE_MS,
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
      pixPollMs: env.JOBS_PIX_POLL_MS,
      pixBatchSize: env.JOBS_PIX_BATCH_SIZE,
      subscriptionMs: env.JOBS_SUBSCRIPTION_MS,
      reconciliationMs: env.JOBS_RECONCILIATION_MS,
      batchSize: env.JOBS_BATCH_SIZE,
    },
    metrics: {
      ...(env.METRICS_TOKEN ? { token: env.METRICS_TOKEN } : {}),
    },
    ...(env.AUTHO_ISSUER_URL && env.AUTHO_ISSUER_SECRET
      ? {
          autho: {
            url: env.AUTHO_ISSUER_URL.replace(/\/+$/, ''),
            tenant: env.AUTHO_TENANT,
            secret: env.AUTHO_ISSUER_SECRET,
          },
        }
      : {}),
    alerts: {
      ...(env.ALERT_WEBHOOK_URL ? { webhookUrl: env.ALERT_WEBHOOK_URL } : {}),
      ...(env.ALERT_WEBHOOK_TOKEN ? { token: env.ALERT_WEBHOOK_TOKEN } : {}),
      timeoutMs: 5_000,
    },
    email: {
      sender: env.EMAIL_SENDER,
      ...(env.EMAIL_FROM ? { from: env.EMAIL_FROM } : {}),
      ...(env.EMAIL_SENDER === 'smtp' && env.SMTP_HOST
        ? {
            smtp: {
              host: env.SMTP_HOST,
              port: env.SMTP_PORT,
              secure: env.SMTP_SECURE,
              starttls: env.SMTP_STARTTLS,
              ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
              ...(env.SMTP_PASS ? { pass: env.SMTP_PASS } : {}),
              timeoutMs: env.SMTP_TIMEOUT_MS,
            },
          }
        : {}),
    },
    env,
  };
}
