import { z } from 'zod';

/**
 * Validacao de environment. Falha cedo e com mensagem clara:
 * um motor com seed faltando deve recusar o boot, nunca derrubar em runtime.
 */

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const intFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const floatFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number());

export const SignerMode = z.enum(['local', 'remote', 'psbt']);
export type SignerMode = z.infer<typeof SignerMode>;

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(4578),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN precisa ter ao menos 16 caracteres'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL obrigatorio'),
  DATABASE_SSL: boolish.default(false),

  DATA_ENCRYPTION_KEY: z.string().min(1, 'DATA_ENCRYPTION_KEY obrigatorio (32 bytes base64)'),
  DATA_INDEX_KEY: z.string().min(1, 'DATA_INDEX_KEY obrigatorio (32 bytes base64)'),

  HD_XPUB: z.string().min(1, 'HD_XPUB obrigatorio (xpub de conta m/44\'/60\'/0\')'),
  HD_DERIVATION_PREFIX: z.string().default('0'),
  HD_ACCOUNT_INDEX: intFromEnv(0),
  HD_MAX_INDEX: intFromEnv(100_000),

  SIGNER_MODE: SignerMode.default('local'),
  SIGNER_KEYSTORE_PATH: z.string().default('./data/keystore.json'),
  SIGNER_PASSPHRASE: z.string().optional(),
  SIGNER_REMOTE_URL: z.string().optional(),
  SIGNER_REMOTE_TOKEN: z.string().optional(),

  GAS_SPONSOR_PRIVATE_KEY: z.string().optional(),
  GAS_SPONSOR_AMOUNT_WEI: z.string().default('500000000000000000'),
  GAS_SPONSOR_MIN_BALANCE_WEI: z.string().default('1000000000000000000'),

  CONFIRMATIONS_REQUIRED: intFromEnv(10),
  PAYMENT_TOLERANCE_PCT: floatFromEnv(1.0),
  MONITOR_INTERVAL_MS: intFromEnv(15_000),
  MONITOR_MAX_TOPICS: intFromEnv(200),
  MONITOR_BLOCK_RANGE: intFromEnv(2_000),
  MONITOR_START_BLOCK: intFromEnv(0),

  RAMP_BASE_URL: z.string().default('https://buy.ramp.network/'),
  RAMP_PARAM_STYLE: z.enum(['legacy', 'unified']).default('legacy'),
  RAMP_HOST_APP_NAME: z.string().default('Motor Cripto'),
  RAMP_HOST_LOGO_URL: z.string().optional(),
  RAMP_FIAT_CURRENCY: z.string().default('BRL'),
  LINK_TTL_HOURS: intFromEnv(72),

  COLD_WALLET_ADDRESS: z.string().optional(),
  COLD_WALLET_LABEL: z.string().default('Cold Wallet Principal'),
});

export type Env = z.infer<typeof EnvSchema>;

export type AppConfig = {
  env: Env;
  server: { port: number; host: string; logLevel: string; adminToken: string; isProduction: boolean };
  database: { url: string; ssl: boolean };
  crypto: {
    dataKey: Buffer;
    indexKey: Buffer;
  };
  hd: {
    xpub: string;
    derivationPrefix: string;
    accountIndex: number;
    maxIndex: number;
  };
  signer: {
    mode: SignerMode;
    keystorePath: string;
    passphrase?: string;
    remoteUrl?: string;
    remoteToken?: string;
  };
  gasSponsor: {
    privateKey?: string;
    amountWei: bigint;
    minBalanceWei: bigint;
  };
  chain: {
    confirmationsRequired: number;
    tolerancePct: number;
    monitorIntervalMs: number;
    maxTopics: number;
    blockRange: number;
    startBlock: number;
  };
  ramp: {
    baseUrl: string;
    paramStyle: 'legacy' | 'unified';
    hostAppName: string;
    hostLogoUrl?: string;
    fiatCurrency: string;
  };
  links: { ttlHours: number };
  coldWallet: { address?: string; label: string };
};

function decodeKey(raw: string, name: string): Buffer {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `${name} deve ter 32 bytes em base64 (recebido ${buf.length}). Gere com: openssl rand -base64 32`,
    );
  }
  return buf;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuracao invalida:\n${issues}`);
  }
  const env = parsed.data;

  return {
    env,
    server: {
      port: env.PORT,
      host: env.HOST,
      logLevel: env.LOG_LEVEL,
      adminToken: env.ADMIN_TOKEN,
      isProduction: env.NODE_ENV === 'production',
    },
    database: { url: env.DATABASE_URL, ssl: env.DATABASE_SSL },
    crypto: {
      dataKey: decodeKey(env.DATA_ENCRYPTION_KEY, 'DATA_ENCRYPTION_KEY'),
      indexKey: decodeKey(env.DATA_INDEX_KEY, 'DATA_INDEX_KEY'),
    },
    hd: {
      xpub: env.HD_XPUB,
      derivationPrefix: env.HD_DERIVATION_PREFIX,
      accountIndex: env.HD_ACCOUNT_INDEX,
      maxIndex: env.HD_MAX_INDEX,
    },
    signer: {
      mode: env.SIGNER_MODE,
      keystorePath: env.SIGNER_KEYSTORE_PATH,
      passphrase: env.SIGNER_PASSPHRASE,
      remoteUrl: env.SIGNER_REMOTE_URL,
      remoteToken: env.SIGNER_REMOTE_TOKEN,
    },
    gasSponsor: {
      privateKey: env.GAS_SPONSOR_PRIVATE_KEY,
      amountWei: BigInt(env.GAS_SPONSOR_AMOUNT_WEI),
      minBalanceWei: BigInt(env.GAS_SPONSOR_MIN_BALANCE_WEI),
    },
    chain: {
      confirmationsRequired: env.CONFIRMATIONS_REQUIRED,
      tolerancePct: env.PAYMENT_TOLERANCE_PCT,
      monitorIntervalMs: env.MONITOR_INTERVAL_MS,
      maxTopics: env.MONITOR_MAX_TOPICS,
      blockRange: env.MONITOR_BLOCK_RANGE,
      startBlock: env.MONITOR_START_BLOCK,
    },
    ramp: {
      baseUrl: env.RAMP_BASE_URL,
      paramStyle: env.RAMP_PARAM_STYLE,
      hostAppName: env.RAMP_HOST_APP_NAME,
      hostLogoUrl: env.RAMP_HOST_LOGO_URL || undefined,
      fiatCurrency: env.RAMP_FIAT_CURRENCY,
    },
    links: { ttlHours: env.LINK_TTL_HOURS },
    coldWallet: {
      address: env.COLD_WALLET_ADDRESS || undefined,
      label: env.COLD_WALLET_LABEL,
    },
  };
}

/** Resolve o RPC de uma chain a partir do ambiente. */
export function rpcUrlFor(chain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = `RPC_URL_${chain.toUpperCase()}`;
  const url = env[key];
  if (!url) throw new Error(`RPC nao configurado para a chain "${chain}" (${key})`);
  return url;
}
