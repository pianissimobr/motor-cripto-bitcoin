import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { SettlementChain } from './domain/types.js';

export const SERVICE_NAME = 'btc-payments';
export const SERVICE_VERSION = '0.1.0';

/**
 * Quantos proxies na frente do motor sao confiaveis (`X-Forwarded-For`).
 *
 * `true` vale **1 salto** (o nginx/Caddy da frente), nunca a cadeia inteira:
 * confiar em tudo faz o Fastify usar o endereco mais a esquerda do cabecalho,
 * que e o que o cliente escreveu — e o rate limit por IP deixa de valer.
 * Um numero N confia em N saltos; `false`/`0` desliga.
 */
const trustProxyFromEnv = () =>
  z
    .string()
    .optional()
    .transform((v, ctx): false | number => {
      const value = (v ?? '').trim().toLowerCase();
      if (value === '' || ['false', 'no', 'off', '0'].includes(value)) return false;
      if (['true', 'yes', 'on'].includes(value)) return 1;
      if (/^[1-9]\d?$/.test(value)) return Number(value);
      ctx.addIssue({ code: 'custom', message: 'TRUST_PROXY: use false, true (1 salto) ou o numero de saltos' });
      return z.NEVER;
    });

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
    TRUST_PROXY: trustProxyFromEnv(),
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
    /** Cache do preco do BTC (as fontes publicas tem cota). */
    FX_PRICE_CACHE_MS: intFromEnv(30_000, 1_000),

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

    // --- Rede de liquidacao (a mesma do PIX) ---
    // O RPC so serve para conferir a entrega do USDC na rede.
    BASE_RPC_URLS: z.string().default('https://mainnet.base.org,https://base-rpc.publicnode.com'),
    BASE_CHAIN_ID: intFromEnv(8453, 1),
    BASE_USDC_ADDRESSES: z
      .string()
      .default('0x833589fCD6EDB6E08F4C7C32D4f71b54BDA02913'),

    POLYGON_RPC_URLS: z.string().default('https://polygon-rpc.com,https://polygon-bor-rpc.publicnode.com'),
    POLYGON_CHAIN_ID: intFromEnv(137, 1),
    // A Lunium entrega o USDC nativo (Circle) ou o bridged (USDC.e) na
    // Polygon? A API nao diz. A verificacao on-chain aceita os dois para a
    // primeira entrega real nao cair em `manual` por adivinhacao; depois do
    // primeiro hash real, deixa so o contrato certo.
    POLYGON_USDC_ADDRESSES: z
      .string()
      .default(
        '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359,0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      ),

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
    /**
     * Rede em que a Lunium entrega o USDC do PIX.
     *
     * `polygon` e o trilho de producao: a chave da LuniumPay esta com
     * `chain: polygon` e o cash-in de USDC/polygon tem o menor custo de
     * saque (0,018 contra 0,1 na Base).
     */
    PIX_CHAIN: z.enum(['base', 'polygon']).default('polygon'),
    // Faixa do cash-in da LuniumPay (leia de GET /keys/me -> limits.cashin:
    // 102 a 600000 centavos na chave de producao). O default antigo (2500) era
    // mais estreito e recusava cobrancas de R$ 10 que a Lunium aceita.
    PIX_MIN_BRL_CENTS: bigintFromEnv('102'),
    PIX_MAX_BRL_CENTS: bigintFromEnv('600000'),
    PIX_VERIFY_SETTLEMENT_TX: boolFromEnv(true),
    /**
     * Confirmacoes exigidas antes de aceitar uma entrega de USDC como prova
     * (liquidacao Pix e entrega de swap). 12 blocos sao ~24 s na Polygon e
     * na Base: cobre as reorganizacoes rasas sem atrasar a liquidacao.
     */
    SETTLEMENT_CONFIRMATIONS: intFromEnv(12, 1, 1_000),

    /**
     * Cash-out (venda de cripto por Pix). Desligado por padrao: o trilho
     * completo depende do app assinar a transferencia (F1).
     */
    CASHOUT_ENABLED: boolFromEnv(false),
    /** Faixa da venda (leia de GET /keys/me -> limits.cashout). */
    CASHOUT_MIN_BRL_CENTS: bigintFromEnv('600'),
    CASHOUT_MAX_BRL_CENTS: bigintFromEnv('25000000'),

    /**
     * Swap (Bitcoin -> dolar digital) pela SwapKit.
     *
     * Desligado por padrao: o trilho depende de uma chave da SwapKit e de um
     * endereco de deposito unico por cobranca, que so os provedores de
     * deposito (NEAR, FLASHNET) entregam.
     */
    SWAPKIT_ENABLED: boolFromEnv(false),
    SWAPKIT_API_URL: httpUrl('SWAPKIT_API_URL invalida').default(
      'https://api.swapkit.dev',
    ),
    SWAPKIT_API_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    /**
     * Provedores, na ordem de preferencia.
     *
     * `NEAR` e `FLASHNET` sao os que aceitam BTC como origem e USDC na
     * Polygon como destino **e** dao um endereco de deposito unico por pedido
     * (sem memo, o que permite um BIP21 comum). `THORCHAIN_STREAMING` nao
     * tem USDC na Polygon e usa cofre compartilhado com memo: nao serve.
     */
    SWAPKIT_PROVIDERS: z.string().trim().default('NEAR,FLASHNET'),
    /** Ativo que o pagador envia. */
    SWAPKIT_SELL_ASSET: z.string().trim().default('BTC.BTC'),
    /**
     * Ativo que o cliente recebe: USDC nativo na Polygon.
     *
     * O contrato e o mesmo que o motor ja usa na liquidacao do PIX
     * (`0x3c499c54...`). A SwapKit identifica o token pelo par chain + endereco.
     */
    SWAPKIT_BUY_ASSET: z
      .string()
      .trim()
      .default('POL.USDC-0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
    /**
     * Unidade do `sellAmount`.
     *
     * A documentacao da SwapKit nao diz se e unidade base (sats) ou decimal
     * (BTC). Os exemplos usam decimal (`0.01`), que e o default; o spike com
     * chave real confirma.
     */
    SWAPKIT_AMOUNT_UNIT: z.enum(['decimal', 'base']).default('decimal'),
    /**
     * Endereco Bitcoin que a SwapKit usa como origem da rota.
     *
     * A API exige um endereco de origem valido (e o tela contra a lista de
     * sanctions). No trilho de deposito o pagador e um terceiro: o endereço
     * aqui e o da plataforma, e o destino padrao do reembolso.
     */
    SWAPKIT_SOURCE_ADDRESS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().trim().min(14).max(120).optional(),
    ),
    SWAPKIT_TIMEOUT_MS: intFromEnv(15_000, 1_000),
    /**
     * A chave da SwapKit aceita 10 requisicoes por minuto por servico.
     * `api` e `worker` sao processos separados e dividem esse teto.
     */
    SWAPKIT_RATE_LIMIT_API_MAX: intFromEnv(6, 1, 10),
    SWAPKIT_RATE_LIMIT_WORKER_MAX: intFromEnv(4, 1, 10),
    SWAPKIT_RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, 1_000),
    SWAPKIT_RATE_LIMIT_MAX_QUEUE: intFromEnv(50, 1, 1_000),
    /** Deslizamento aceito na cotacao, em basis points. */
    SWAPKIT_SLIPPAGE_BPS: intFromEnv(100, 1, 5_000),
    /** Faixa aceita do swap (o teto da chave da SwapKit e menor). */
    SWAPKIT_MIN_BRL_CENTS: bigintFromEnv('102'),
    SWAPKIT_MAX_BRL_CENTS: bigintFromEnv('600000'),

    RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, 1_000),
    RATE_LIMIT_MAX: intFromEnv(120, 1),

    SESSION_TTL_SECONDS: intFromEnv(604_800, 600, 31_536_000),

    /** Painel do lojista (`/painel` e `/auth/*`). Desligado por padrao. */
    DASHBOARD_ENABLED: boolFromEnv(false),
    /** Fecha o cadastro de contas novas sem desligar o login. */
    DASHBOARD_SIGNUP_ENABLED: boolFromEnv(true),
    /**
     * authO no perfil issuer: codigo de 6 digitos por e-mail e anti-robo
     * (ALTCHA). Obrigatorio em producao com o painel ligado.
     */
    AUTHO_ISSUER_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      httpUrl('AUTHO_ISSUER_URL invalida').optional(),
    ),
    AUTHO_TENANT: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(1).max(100).optional(),
    ),
    /**
     * App de pagamento da Nuvemshop (programa de parceiros). Sem os tres, a
     * integracao fica desligada.
     */
    NUVEMSHOP_APP_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(40).optional()),
    NUVEMSHOP_CLIENT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(100).optional()),
    NUVEMSHOP_CLIENT_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).max(200).optional()),
    NUVEMSHOP_API_BASE: httpUrl('NUVEMSHOP_API_BASE invalida').default('https://api.tiendanube.com/2025-03'),
    /** CNPJ do provedor de pagamento, exigido nas transacoes no Brasil. */
    NUVEMSHOP_PROVIDER_TAX_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(20).optional()),
    /** Chave publica (PEM) que confere o X-Signature das chamadas da Nuvemshop. */
    NUVEMSHOP_SIGNING_PUBLIC_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(5000).optional()),
    AUTHO_ISSUER_SECRET: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(16, 'AUTHO_ISSUER_SECRET precisa ter ao menos 16 caracteres').optional(),
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
    /**
     * Destinatarios do alerta por e-mail (separados por virgula).
     *
     * O canal de e-mail usa o mesmo relay SMTP do restante do motor; sem
     * `ALERT_EMAIL_TO` o alerta so sai pelo webhook.
     */
    ALERT_EMAIL_TO: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().min(3).optional(),
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

    // --- Gas station (tesouraria de nativo) ---
    // Repoe o gas das saidas on-chain do cliente: o usuario tem a stablecoin,
    // nao o nativo. A chave e isolada e so serve para o gas.
    GAS_STATION_ENABLED: boolFromEnv(false),
    GAS_STATION_PRIVATE_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'GAS_STATION_PRIVATE_KEY invalida').optional(),
    ),
    GAS_STATION_RPC_URLS: z
      .string()
      .default('https://polygon-bor-rpc.publicnode.com,https://polygon-rpc.com'),
    GAS_STATION_CHAIN_ID: intFromEnv(137, 1),
    /** Teto por reposicao, em wei (0,05 POL). */
    GAS_STATION_MAX_TOPUP_WEI: bigintFromEnv('50000000000000000'),
    /** Piso da tesouraria: abaixo disso, o motor nao repõe. */
    GAS_STATION_MIN_TREASURY_WEI: bigintFromEnv('100000000000000000'),
    /** Teto global de reposicoes por dia (o cadastro de device e aberto). */
    GAS_STATION_MAX_TOPUPS_PER_DAY: intFromEnv(50, 0),
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
    if (env.PIX_ENABLED) {
      const raw = env.PIX_CHAIN === 'polygon' ? env.POLYGON_USDC_ADDRESSES : env.BASE_USDC_ADDRESSES;
      const addresses = raw
        .split(',')
        .map((address) => address.trim())
        .filter((address) => /^0x[a-fA-F0-9]{40}$/.test(address));
      if (addresses.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: [
            env.PIX_CHAIN === 'polygon' ? 'POLYGON_USDC_ADDRESSES' : 'BASE_USDC_ADDRESSES',
          ],
          message: 'informe ao menos um contrato de USDC valido',
        });
      }
    }
    if (env.GAS_STATION_ENABLED && !env.GAS_STATION_PRIVATE_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GAS_STATION_PRIVATE_KEY'],
        message: 'obrigatorio quando GAS_STATION_ENABLED=true',
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
    if (env.SWAPKIT_ENABLED && !env.SWAPKIT_SOURCE_ADDRESS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SWAPKIT_SOURCE_ADDRESS'],
        message: 'obrigatorio quando SWAPKIT_ENABLED=true (a SwapKit exige um endereco de origem)',
      });
    }
    if (env.SWAPKIT_ENABLED && !env.SWAPKIT_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SWAPKIT_API_KEY'],
        message: 'obrigatorio quando SWAPKIT_ENABLED=true',
      });
    }
    if (env.SWAPKIT_ENABLED && !env.ONCHAIN_ENABLED && !env.PIX_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['SWAPKIT_ENABLED'],
        message:
          'o swap entrega USDC na Polygon: habilite ONCHAIN_ENABLED ou PIX_ENABLED para a liquidacao',
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
    const authoSet = [env.AUTHO_ISSUER_URL, env.AUTHO_TENANT, env.AUTHO_ISSUER_SECRET].filter(Boolean).length;
    if (authoSet !== 0 && authoSet !== 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTHO_ISSUER_URL'],
        message: 'AUTHO_ISSUER_URL, AUTHO_TENANT e AUTHO_ISSUER_SECRET vao juntos',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.DASHBOARD_ENABLED && authoSet !== 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTHO_ISSUER_URL'],
        message: 'em producao o painel exige o authO (codigo por e-mail e anti-robo)',
      });
    }
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
    /** `false` ou o numero de proxies confiaveis na frente do motor. */
    trustProxy: false | number;
    corsAllowedOrigins: string[];
    rateLimitWindowMs: number;
    rateLimitMax: number;
    sessionTtlSeconds: number;
  };
  nuvemshop: {
    appId: string;
    clientId: string;
    clientSecret: string;
    apiBase: string;
    providerTaxId: string | null;
    signingPublicKey: string | null;
  } | null;
  dashboard: {
    enabled: boolean;
    signupEnabled: boolean;
    autho: { url: string; tenant: string; secret: string } | null;
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
    /** Cache do preco do BTC (as fontes publicas tem cota). */
    priceCacheMs: number;
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
  /**
   * Rede em que a liquidacao do USDC acontece: a mesma do PIX. O RPC serve
   * so para conferir a entrega on-chain.
   */
  settlement: {
    chain: SettlementChain;
    rpcUrls: string[];
    chainId: number;
    /** Contratos aceitos como USDC na rede (nativo e bridged). */
    usdcAddresses: string[];
    nativeSymbol: string;
    /** Profundidade minima do bloco de uma entrega de USDC. */
    confirmations: number;
  };
  pix: {
    enabled: boolean;
    luniumApiUrl: string;
    luniumApiKey?: string;
    luniumWebhookSecret?: string;
    timeoutMs: number;
    asset: 'usdc';
    chain: SettlementChain;
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
  /** Cash-out: venda de cripto por Pix (o app assina; o motor orquestra). */
  cashout: {
    enabled: boolean;
    /** Ativo e rede da venda (o trilho rapido da Lunium e USDC/polygon). */
    asset: 'USDC';
    network: 'polygon';
    /** Faixa aceita: a LuniumPay vai de R$ 6,00 a R$ 250.000,00 por vez. */
    minBrlCents: bigint;
    maxBrlCents: bigint;
  };
  /** Swap: Bitcoin -> dolar digital, pela SwapKit. */
  swapkit: {
    enabled: boolean;
    apiUrl: string;
    apiKey?: string;
    /** Provedores na ordem de preferencia. */
    providers: string[];
    /** Ativo que o pagador envia (ex.: `BTC.BTC`). */
    sellAsset: string;
    /** Ativo que o cliente recebe (ex.: `POL.USDC-0x3c499c...`). */
    buyAsset: string;
    amountUnit: 'decimal' | 'base';
    /** Endereco Bitcoin de origem da rota (a SwapKit exige). */
    sourceAddress?: string;
    timeoutMs: number;
    slippageBps: number;
    minBrlCents: bigint;
    maxBrlCents: bigint;
    rateLimit: {
      apiMax: number;
      workerMax: number;
      windowMs: number;
      maxQueue: number;
    };
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
  alerts: {
    webhookUrl?: string;
    token?: string;
    timeoutMs: number;
    /** Destinatarios do canal de e-mail. */
    emailTo?: string[];
  };
  gasStation: {
    enabled: boolean;
    privateKey?: string;
    rpcUrls: string[];
    chainId: number;
    maxTopUpWei: bigint;
    minTreasuryWei: bigint;
    maxTopUpsPerDay: number;
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
 * Configura a rede de liquidacao de acordo com a chain do PIX.
 *
 * A lista de contratos de USDC aceita mais de um endereco porque a Lunium
 * pode entregar o token nativo ou o bridged: a API nao revela qual, e uma
 * verificacao on-chain com o endereco errado joga a cobranca para `manual`
 * mesmo com o dinheiro entregue.
 */
function buildSettlement(env: Env): AppConfig['settlement'] {
  const polygon = env.PIX_CHAIN === 'polygon';
  const rpcUrls = (polygon ? env.POLYGON_RPC_URLS : env.BASE_RPC_URLS)
    .split(',')
    .map((url) => url.trim().replace(/\/+$/, ''))
    .filter((url) => url.length > 0);
  const raw = polygon ? env.POLYGON_USDC_ADDRESSES : env.BASE_USDC_ADDRESSES;
  const usdcAddresses = raw
    .split(',')
    .map((address) => address.trim())
    .filter((address) => /^0x[a-fA-F0-9]{40}$/.test(address));
  return {
    chain: env.PIX_CHAIN,
    rpcUrls,
    chainId: polygon ? env.POLYGON_CHAIN_ID : env.BASE_CHAIN_ID,
    usdcAddresses,
    nativeSymbol: polygon ? 'POL' : 'ETH',
    confirmations: env.SETTLEMENT_CONFIRMATIONS,
  };
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
    nuvemshop:
      env.NUVEMSHOP_APP_ID && env.NUVEMSHOP_CLIENT_ID && env.NUVEMSHOP_CLIENT_SECRET
        ? {
            appId: env.NUVEMSHOP_APP_ID,
            clientId: env.NUVEMSHOP_CLIENT_ID,
            clientSecret: env.NUVEMSHOP_CLIENT_SECRET,
            apiBase: env.NUVEMSHOP_API_BASE.replace(/\/+$/, ''),
            providerTaxId: env.NUVEMSHOP_PROVIDER_TAX_ID ?? null,
            signingPublicKey: env.NUVEMSHOP_SIGNING_PUBLIC_KEY?.replace(/\\n/g, '\n') ?? null,
          }
        : null,
    dashboard: {
      enabled: env.DASHBOARD_ENABLED,
      signupEnabled: env.DASHBOARD_SIGNUP_ENABLED,
      autho:
        env.AUTHO_ISSUER_URL && env.AUTHO_TENANT && env.AUTHO_ISSUER_SECRET
          ? { url: env.AUTHO_ISSUER_URL, tenant: env.AUTHO_TENANT, secret: env.AUTHO_ISSUER_SECRET }
          : null,
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
      priceCacheMs: env.FX_PRICE_CACHE_MS,
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
    settlement: buildSettlement(env),
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
    cashout: {
      enabled: env.CASHOUT_ENABLED,
      asset: 'USDC',
      network: 'polygon',
      minBrlCents: env.CASHOUT_MIN_BRL_CENTS,
      maxBrlCents: env.CASHOUT_MAX_BRL_CENTS,
    },
    swapkit: {
      enabled: env.SWAPKIT_ENABLED,
      apiUrl: env.SWAPKIT_API_URL.replace(/\/+$/, ''),
      ...(env.SWAPKIT_API_KEY ? { apiKey: env.SWAPKIT_API_KEY } : {}),
      providers: env.SWAPKIT_PROVIDERS.split(',')
        .map((provider) => provider.trim())
        .filter((provider) => provider.length > 0),
      sellAsset: env.SWAPKIT_SELL_ASSET,
      buyAsset: env.SWAPKIT_BUY_ASSET,
      amountUnit: env.SWAPKIT_AMOUNT_UNIT,
      ...(env.SWAPKIT_SOURCE_ADDRESS ? { sourceAddress: env.SWAPKIT_SOURCE_ADDRESS } : {}),
      timeoutMs: env.SWAPKIT_TIMEOUT_MS,
      slippageBps: env.SWAPKIT_SLIPPAGE_BPS,
      minBrlCents: env.SWAPKIT_MIN_BRL_CENTS,
      maxBrlCents: env.SWAPKIT_MAX_BRL_CENTS,
      rateLimit: {
        apiMax: env.SWAPKIT_RATE_LIMIT_API_MAX,
        workerMax: env.SWAPKIT_RATE_LIMIT_WORKER_MAX,
        windowMs: env.SWAPKIT_RATE_LIMIT_WINDOW_MS,
        maxQueue: env.SWAPKIT_RATE_LIMIT_MAX_QUEUE,
      },
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
    alerts: {
      ...(env.ALERT_WEBHOOK_URL ? { webhookUrl: env.ALERT_WEBHOOK_URL } : {}),
      ...(env.ALERT_WEBHOOK_TOKEN ? { token: env.ALERT_WEBHOOK_TOKEN } : {}),
      ...(env.ALERT_EMAIL_TO
        ? {
            emailTo: env.ALERT_EMAIL_TO.split(',')
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          }
        : {}),
      timeoutMs: 5_000,
    },
    gasStation: {
      enabled: env.GAS_STATION_ENABLED,
      ...(env.GAS_STATION_PRIVATE_KEY
        ? { privateKey: env.GAS_STATION_PRIVATE_KEY }
        : {}),
      rpcUrls: env.GAS_STATION_RPC_URLS.split(',')
        .map((url) => url.trim().replace(/\/+$/, ''))
        .filter((url) => url.length > 0),
      chainId: env.GAS_STATION_CHAIN_ID,
      maxTopUpWei: env.GAS_STATION_MAX_TOPUP_WEI,
      minTreasuryWei: env.GAS_STATION_MIN_TREASURY_WEI,
      maxTopUpsPerDay: env.GAS_STATION_MAX_TOPUPS_PER_DAY,
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
