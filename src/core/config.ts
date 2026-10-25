import { Wallet, getAddress } from 'ethers';
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

const intFromEnv = (def: number, bounds: { min?: number; max?: number } = {}) => {
  let schema = z.number().int();
  if (bounds.min !== undefined) schema = schema.min(bounds.min);
  if (bounds.max !== undefined) schema = schema.max(bounds.max);
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(schema);
};

const floatFromEnv = (def: number, bounds: { min?: number; max?: number } = {}) => {
  let schema = z.number();
  if (bounds.min !== undefined) schema = schema.min(bounds.min);
  if (bounds.max !== undefined) schema = schema.max(bounds.max);
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(schema);
};

/**
 * Wei vem do ambiente como string (bigint nao cabe em Number).
 * Validar o formato aqui evita `BigInt('...')` estourar no meio do boot
 * com mensagem opaca.
 */
const weiFromEnv = (def: string) =>
  z
    .string()
    .default(def)
    .refine((v) => /^\d+$/.test(v), {
      message: 'deve ser um inteiro nao-negativo em wei (string decimal)',
    })
    .transform((v) => BigInt(v));

export const SignerMode = z.enum(['local', 'remote', 'psbt']);
export type SignerMode = z.infer<typeof SignerMode>;

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export const EnvSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(4578, { min: 1, max: 65535 }),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN precisa ter ao menos 16 caracteres'),
  // `trustProxy` cego deixa qualquer cliente forjar X-Forwarded-For e burlar
  // rate limit / poluir o IP da auditoria. Default: nao confiar.
  TRUST_PROXY: boolish.default(false),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL obrigatorio'),
  DATABASE_SSL: boolish.default(false),
  /** PEM da CA, quando o servidor nao usa uma CA publica. */
  DATABASE_SSL_CA: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(1).optional(),
  ),

  DATA_ENCRYPTION_KEY: z.string().min(1, 'DATA_ENCRYPTION_KEY obrigatorio (32 bytes base64)'),
  // E2: keyring de cifragem. JSON { "k1": "<b64 32>", "k2": "<b64 32>" }.
  // Opcional: se ausente, usa DATA_ENCRYPTION_KEY como chave unica "k1".
  KEYRING: z.string().optional(),
  DATA_ACTIVE_KID: z.string().default('k1'),
  DATA_LEGACY_KID: z.string().optional(),

  HD_XPUB: z.string().min(1, 'HD_XPUB obrigatorio (xpub de conta m/44\'/60\'/0\')'),
  HD_DERIVATION_PREFIX: z.string().default('0'),
  HD_ACCOUNT_INDEX: intFromEnv(0, { min: 0 }),
  HD_MAX_INDEX: intFromEnv(100_000, { min: 0 }),

  SIGNER_MODE: SignerMode.default('local'),
  SIGNER_KEYSTORE_PATH: z.string().default('./data/keystore.json'),
  SIGNER_PASSPHRASE: z.string().optional(),
  SIGNER_REMOTE_URL: z.string().optional(),
  SIGNER_REMOTE_TOKEN: z.string().optional(),

  GAS_SPONSOR_PRIVATE_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'deve ser uma chave privada 0x + 64 hex')
      .optional(),
  ),
  /** Endereco publico do patrocinador. A API consulta saldo sem a chave. */
  GAS_SPONSOR_ADDRESS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'deve ser um endereco 0x + 40 hex').optional(),
  ),
  // 0,5 POL por patrocinio e um piso de 0,1 POL no destino. O piso precisa
  // ser menor que o envio, senao o motor manda gas a cada sweep.
  GAS_SPONSOR_AMOUNT_WEI: weiFromEnv('500000000000000000'),
  GAS_SPONSOR_MIN_BALANCE_WEI: weiFromEnv('100000000000000000'),

  CONFIRMATIONS_REQUIRED: intFromEnv(10, { min: 1 }),
  PAYMENT_TOLERANCE_PCT: floatFromEnv(1.0, { min: 0, max: 100 }),
  MONITOR_INTERVAL_MS: intFromEnv(15_000, { min: 1_000 }),
  MONITOR_MAX_TOPICS: intFromEnv(200, { min: 1 }),
  MONITOR_BLOCK_RANGE: intFromEnv(2_000, { min: 1 }),
  MONITOR_START_BLOCK: intFromEnv(0, { min: 0 }),
  // C1: teto da varredura. `finalized` = so blocos com finalidade
  // (Polygon PoS tem checkpoint); `latest` = inclui blocos reescrevivel.
  MONITOR_BLOCK_TAG: z.enum(['finalized', 'latest']).default('finalized'),
  // C2: intervalo (em blocos) entre duas ancoras de hash.
  MONITOR_ANCHOR_INTERVAL: intFromEnv(32, { min: 1 }),
  /** Quantos blocos reler quando um link aguardando tem saldo e o log passou batido. */
  MONITOR_BACKFILL_BLOCKS: intFromEnv(100_000, { min: 1 }),

  RAMP_BASE_URL: z
    .string()
    .url('deve ser uma URL absoluta')
    .refine(isHttpUrl, 'deve usar http(s)')
    .default('https://app.ramp.network/'),
  RAMP_PARAM_STYLE: z.enum(['legacy', 'unified']).default('legacy'),
  RAMP_HOST_APP_NAME: z.string().trim().min(1).max(80).default('Motor Cripto'),
  RAMP_HOST_LOGO_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .url('deve ser uma URL absoluta')
      .refine(isHttpUrl, 'deve usar http(s)')
      .optional(),
  ),
  RAMP_FIAT_CURRENCY: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'deve ter 3 letras')
    .transform((v) => v.toUpperCase())
    .default('BRL'),
  /** URL publica usada para montar a pagina de pagamento /p/:token. */
  PUBLIC_BASE_URL: z
    .string()
    .url('deve ser uma URL absoluta')
    .refine(isHttpUrl, 'deve usar http(s)')
    .default('http://localhost:4578'),
  /** Tempo de vida da pagina/widget. O pagamento on-chain continua depois. */
  LINK_TTL_MINUTES: intFromEnv(60, { min: 1 }),
  /** Janela de liquidacao apos o fim da pagina, em dias corridos. */
  SETTLEMENT_DAYS: intFromEnv(1, { min: 0 }),

  WEBHOOK_TIMEOUT_MS: intFromEnv(10_000, { min: 1_000 }),
  WEBHOOK_MAX_ATTEMPTS: intFromEnv(6, { min: 1 }),
  })
  .superRefine((env, ctx) => {
    if (env.GAS_SPONSOR_PRIVATE_KEY && env.GAS_SPONSOR_ADDRESS) {
      const derived = new Wallet(env.GAS_SPONSOR_PRIVATE_KEY).address;
      if (getAddress(derived) !== getAddress(env.GAS_SPONSOR_ADDRESS)) {
        ctx.addIssue({
          code: 'custom',
          path: ['GAS_SPONSOR_ADDRESS'],
          message: 'nao corresponde a GAS_SPONSOR_PRIVATE_KEY',
        });
      }
    }
    if (env.GAS_SPONSOR_PRIVATE_KEY) {
      if (env.GAS_SPONSOR_AMOUNT_WEI <= 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['GAS_SPONSOR_AMOUNT_WEI'],
          message: 'precisa ser maior que zero quando o patrocinador esta configurado',
        });
      }
      if (env.GAS_SPONSOR_MIN_BALANCE_WEI > env.GAS_SPONSOR_AMOUNT_WEI) {
        ctx.addIssue({
          code: 'custom',
          path: ['GAS_SPONSOR_MIN_BALANCE_WEI'],
          message: 'nao pode ser maior que GAS_SPONSOR_AMOUNT_WEI (senao todo sweep patrocina de novo)',
        });
      }
    }
    if (env.SIGNER_MODE === 'remote' && !env.SIGNER_REMOTE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNER_REMOTE_URL'],
        message: 'SIGNER_REMOTE_URL obrigatorio quando SIGNER_MODE=remote',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.ADMIN_TOKEN.length < 32 || env.ADMIN_TOKEN === ADMIN_TOKEN_EXEMPLO) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_TOKEN'],
        message: 'em producao precisa ter ao menos 32 caracteres e nao pode ser o valor de exemplo',
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
        message: 'SIGNER_REMOTE_URL precisa ser https em producao',
      });
    }
  });

/** Valor publicado no .env.example. Nao pode ir para producao. */
const ADMIN_TOKEN_EXEMPLO = 'troque-este-token-por-um-valor-aleatorio-longo';

export type Env = z.infer<typeof EnvSchema>;

/**
 * E1/E2: monta o keyring a partir do ambiente.
 *
 * Se KEYRING existir, usa ele (rotacao). Senao, cai para DATA_ENCRYPTION_KEY
 * como chave unica "k1" - que e o estado antes da rotacao.
 */
function buildCrypto(env: Env): AppConfig['crypto'] {
  let keyring: Record<string, Buffer>;
  if (env.KEYRING && env.KEYRING.trim().length > 0) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(env.KEYRING) as Record<string, string>;
    } catch {
      throw new Error('KEYRING precisa ser JSON: { "k1": "<base64>", "k2": "<base64>" }');
    }
    keyring = {};
    for (const [kid, b64] of Object.entries(parsed)) {
      keyring[kid] = decodeKey(b64, `KEYRING.${kid}`);
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

export type AppConfig = {
  env: Env;
  server: {
    port: number;
    host: string;
    logLevel: string;
    adminToken: string;
    trustProxy: boolean;
    isProduction: boolean;
  };
  database: { url: string; ssl: false | { ca?: string } };
  crypto: {
    /** E1/E2: chaves de cifragem por id + chave ativa. */
    keyring: Record<string, Buffer>;
    activeKid: string;
    legacyKid: string;
    /** Compatibilidade: chave unica (primeira do keyring). */
    dataKey: Buffer;
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
    /** Endereco publico. A API usa so este campo. */
    address?: string;
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
    /** C1 */
    blockTag: 'finalized' | 'latest';
    /** C2 */
    anchorInterval: number;
    backfillBlocks: number;
  };
  ramp: {
    baseUrl: string;
    paramStyle: 'legacy' | 'unified';
    hostAppName: string;
    hostLogoUrl?: string;
    fiatCurrency: string;
  };
  publicBaseUrl: string;
  links: { ttlMinutes: number };
  settlement: { days: number };
  webhook: {
    timeoutMs: number;
    maxAttempts: number;
  };
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

export type ConfigRole = 'api' | 'worker';

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  options: { role?: ConfigRole } = {},
): AppConfig {
  const role = options.role ?? 'worker';
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuracao invalida:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (role !== 'api') {
      const problemas: string[] = [];
      if (env.SIGNER_MODE === 'local' && !env.SIGNER_PASSPHRASE) {
        problemas.push(
          'SIGNER_PASSPHRASE: SIGNER_PASSPHRASE obrigatorio em producao (keystore cifrado)',
        );
      }
      if (
        env.SIGNER_MODE === 'local' &&
        env.SIGNER_PASSPHRASE &&
        env.SIGNER_PASSPHRASE.length < 16
      ) {
        problemas.push('SIGNER_PASSPHRASE: em producao precisa ter ao menos 16 caracteres');
      }
      if (env.SIGNER_MODE === 'remote' && !env.SIGNER_REMOTE_TOKEN) {
        problemas.push('SIGNER_REMOTE_TOKEN: SIGNER_REMOTE_TOKEN obrigatorio em producao');
      }
      if (problemas.length > 0) {
        throw new Error(
          `Configuracao invalida:\n${problemas.map((p) => `  - ${p}`).join('\n')}`,
        );
      }
    }
    const rpcInseguro = Object.entries(source).find(
      ([key, value]) =>
        key.startsWith('RPC_URL_') &&
        typeof value === 'string' &&
        value.length > 0 &&
        !value.startsWith('https://'),
    );
    if (rpcInseguro) {
      throw new Error(
        `Configuracao invalida:\n  - ${rpcInseguro[0]}: precisa ser https em producao`,
      );
    }
  }

  return {
    env,
    server: {
      port: env.PORT,
      host: env.HOST,
      logLevel: env.LOG_LEVEL,
      adminToken: env.ADMIN_TOKEN,
      trustProxy: env.TRUST_PROXY,
      isProduction: env.NODE_ENV === 'production',
    },
    database: {
      url: env.DATABASE_URL,
      ssl: env.DATABASE_SSL ? { ca: env.DATABASE_SSL_CA } : false,
    },
    crypto: buildCrypto(env),
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
      address: env.GAS_SPONSOR_ADDRESS,
      amountWei: env.GAS_SPONSOR_AMOUNT_WEI,
      minBalanceWei: env.GAS_SPONSOR_MIN_BALANCE_WEI,
    },
    chain: {
      confirmationsRequired: env.CONFIRMATIONS_REQUIRED,
      tolerancePct: env.PAYMENT_TOLERANCE_PCT,
      monitorIntervalMs: env.MONITOR_INTERVAL_MS,
      maxTopics: env.MONITOR_MAX_TOPICS,
      blockRange: env.MONITOR_BLOCK_RANGE,
      startBlock: env.MONITOR_START_BLOCK,
      blockTag: env.MONITOR_BLOCK_TAG,
      anchorInterval: env.MONITOR_ANCHOR_INTERVAL,
      backfillBlocks: env.MONITOR_BACKFILL_BLOCKS,
    },
    ramp: {
      baseUrl: env.RAMP_BASE_URL,
      paramStyle: env.RAMP_PARAM_STYLE,
      hostAppName: env.RAMP_HOST_APP_NAME,
      hostLogoUrl: env.RAMP_HOST_LOGO_URL || undefined,
      fiatCurrency: env.RAMP_FIAT_CURRENCY,
    },
    publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    links: { ttlMinutes: env.LINK_TTL_MINUTES },
    settlement: { days: env.SETTLEMENT_DAYS },
    webhook: {
      timeoutMs: env.WEBHOOK_TIMEOUT_MS,
      maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
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
