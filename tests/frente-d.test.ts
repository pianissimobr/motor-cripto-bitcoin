import { describe, expect, it, beforeEach } from 'vitest';
import { HDNodeWallet, Mnemonic } from 'ethers';

import { Sweeper } from '../src/core/chain/sweeper.js';
import { createMotor } from '../src/core/index.js';
import { HdWallet } from '../src/core/hd/hd-wallet.js';
import { silentLogger } from '../src/core/logger.js';
import { createFakeRepositories } from './fakes.js';

/**
 * Frente D - sweeper robusto.
 *
 * D2: o gas nativo residual volta para a carteira fria (nada de poeira
 *     presa em endereco que ninguem mais usa).
 * D3: nao cria uma segunda transacao enquanto a primeira esta pendente
 *     (competiriam pelo mesmo nonce e a segunda poderia substitui-la).
 * D4: idempotencia por (link, nonce) - um link nao gera dois sweeps do
 *     mesmo nonce.
 * D5: gas sponsor sem saldo vira 'pago_sem_gas' com o motivo registrado,
 *     em vez de estourar como falha do sweep.
 */

const MNEMONIC = 'test test test test test test test test test test test junk';
const accountNode = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), "m/44'/60'/0'");
const XPUB = accountNode.neuter().extendedKey;

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const CARTEIRA = '0x1111111111111111111111111111111111111111';

/** Provider fake com saldo de token e nativo controlados. */
function makeProvider(opts: {
  tokenBalance: bigint;
  nativeBalance: bigint;
  noncePending?: number;
  nonceLatest?: number;
  tokenNativeAfter?: bigint;
  dustNativeAfter?: bigint;
}) {
  const estado = {
    tokenBalance: opts.tokenBalance,
    nativeBalance: opts.nativeBalance,
    dustEnviado: false,
  };
  const provider = {
    network: { chainId: 137n },
    estado,
    getBalance: async () => estado.nativeBalance,
    getBlockNumber: async () => 1000,
    getFeeData: async () => ({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    getTransactionCount: async (_addr: string, tag?: string) =>
      tag === 'pending' ? (opts.noncePending ?? 0) : (opts.nonceLatest ?? 0),
    estimateGas: async () => 60_000n,
    getCode: async () => '0x60',
    getBlock: async () => null,
    getLogs: async () => [],
    call: async (req: { to: string; data: string }) => {
      // balanceOf
      if (req.data?.startsWith('0x70a08231')) {
        return '0x' + estado.tokenBalance.toString(16).padStart(64, '0');
      }
      return '0x';
    },
    broadcastTransaction: async (raw: string) => {
      // Transfer de token zera o saldo; envio nativo (dust) reduz o nativo.
      if (raw.length > 10 && estado.tokenBalance > 0n) {
        estado.tokenBalance = 0n;
        if (opts.tokenNativeAfter !== undefined) {
          estado.nativeBalance = opts.tokenNativeAfter;
        }
      } else {
        estado.nativeBalance = opts.dustNativeAfter ?? 0n;
      }
      return {
        hash: '0x' + Math.random().toString(16).slice(2, 12),
        wait: async () => ({ status: 1, blockNumber: 999, gasUsed: 50_000n }),
      };
    },
  };
  return provider;
}

function setup() {
  const repos = createFakeRepositories();
  const motor = createMotor({
    repos,
    hdWallet: HdWallet.fromAccountXpub(XPUB, '0', 0),
    signer: {
      mode: 'local',
      addressFor: (i: number) => HdWallet.fromAccountXpub(XPUB, '0', 0).deriveAddress(i),
      signTransfer: async () => ({ rawTransaction: '0x' + 'ab'.repeat(40), hash: '0xsig' }),
      buildUnsigned: () => ({
        from: '', to: '', data: '0x', value: '0', chainId: 137, nonce: 0, gasLimit: '0',
      }),
      describe: () => 'fake',
    },
    providerFactory: () => {
      throw new Error('provider nao usado');
    },
    gasSponsor: {
      enabled: false, address: null, balance: async () => 0n, ensureGas: async () => false,
    } as never,
    logger: silentLogger,
    dataKey: Buffer.alloc(32, 7),
    indexKey: Buffer.alloc(32, 9),
    ttlHours: 72,
  });
  return { repos, motor };
}

function makeSweeper(ctx: ReturnType<typeof setup>, provider: unknown, opts?: {
  sponsorEnabled?: boolean;
  sponsorThrows?: string;
}) {
  const gasSponsor = opts?.sponsorThrows
    ? {
        enabled: true,
        address: '0xS',
        balance: async () => 0n,
        ensureGas: async () => {
          throw new Error(opts.sponsorThrows!);
        },
      }
    : {
        enabled: opts?.sponsorEnabled ?? false,
        address: opts?.sponsorEnabled ? '0xS' : null,
        balance: async () => 0n,
        ensureGas: async () => false,
      };
  return new Sweeper({
    repos: ctx.repos,
    providerFactory: () => provider as never,
    signer: {
      mode: 'local',
      addressFor: (i: number) => HdWallet.fromAccountXpub(XPUB, '0', 0).deriveAddress(i),
      signTransfer: async () => ({ rawTransaction: '0x' + 'ab'.repeat(40), hash: '0xsig' }),
      buildUnsigned: () => ({
        from: '', to: '', data: '0x', value: '0', chainId: 137, nonce: 0, gasLimit: '0',
      }),
      describe: () => 'fake',
    },
    gasSponsor: gasSponsor as never,
    linkState: ctx.motor.linkState,
    logger: silentLogger,
    options: {
      gasSponsorAmountWei: 1n,
      gasSponsorMinBalanceWei: 1n,
      batchSize: 10,
      reconcileBatchSize: 10,
      tolerancePct: 1,
    },
  });
}

async function seedLink(ctx: ReturnType<typeof setup>) {
  const perfil = await ctx.repos.rampProfiles.create({
    label: 'Polygon USDC',
    chain: 'polygon',
    asset: 'USDC',
    tokenContract: USDC,
    decimals: 6,
    fiatCurrency: 'BRL',
    baseUrl: 'https://buy.ramp.network/',
    paramStyle: 'legacy',
    hostAppName: 'Motor',
    hostApiKey: null,
    rampAssetKey: 'POLYGON_USDC',
    taxaTokenPorFiatBaseUnits: 180_000n,
  });
  await ctx.repos.coldWallets.create({
    label: 'Fria',
    address: CARTEIRA,
    chain: 'polygon',
  });
  const cliente = await ctx.motor.customers.create({
    nome: 'Maria Silva',
    email: 'maria@example.com',
  });
  const link = await ctx.motor.links.create({
    clienteId: cliente.id,
    amountCents: 10_000,
    rampProfileId: perfil.id,
    coldWalletAddress: CARTEIRA,
  });
  await ctx.repos.links.updateStatus(link.id, 'pago');
  return link;
}

/* ================================================================== */

describe('D3: nao duplica transacao pendente', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
  });

  it('ignora o link quando ha nonce pendente acima do confirmado', async () => {
    const link = await seedLink(ctx);
    const provider = makeProvider({
      tokenBalance: 10_000_000n,
      nativeBalance: 10n ** 18n,
      noncePending: 1,
      nonceLatest: 0,
    });
    const sweeper = makeSweeper(ctx, provider);

    const r = await sweeper.runCycle();
    expect(r.movidos).toBe(0);

    // Nenhum movimento deve ter sido criado.
    const movimentos = await ctx.repos.transfers.findByLink(link.id);
    expect(movimentos).toHaveLength(0);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('pago');
  });

  it('segue quando pending == latest (nada em voo)', async () => {
    const link = await seedLink(ctx);
    const provider = makeProvider({
      tokenBalance: 10_000_000n,
      nativeBalance: 10n ** 18n,
      noncePending: 0,
      nonceLatest: 0,
    });
    const sweeper = makeSweeper(ctx, provider);

    const r = await sweeper.runCycle();
    expect(r.movidos).toBe(1);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('movido');
  });
});

describe('D4: idempotencia por (link, nonce)', () => {
  it('nao cria um segundo sweep do mesmo link', async () => {
    const ctx = setup();
    const link = await seedLink(ctx);
    const provider = makeProvider({ tokenBalance: 10_000_000n, nativeBalance: 10n ** 18n });
    const sweeper = makeSweeper(ctx, provider);

    await sweeper.runCycle();
    const depoisPrimeiro = await ctx.repos.transfers.findByLink(link.id);
    const txCountDepoisPrimeiro = depoisPrimeiro.filter((t) => t.status !== 'falhou').length;

    // Segundo ciclo: o token ja foi movido, mas forcamos o saldo de novo.
    provider.estado.tokenBalance = 10_000_000n;
    await sweeper.runCycle();
    const depoisSegundo = await ctx.repos.transfers.findByLink(link.id);

    // Nao pode ter crescido com um sweep de token duplicado.
    const sweepsDeToken = depoisSegundo.filter((t) => t.erro !== 'retorno de gas nativo (dust)');
    expect(sweepsDeToken.length).toBeLessThanOrEqual(txCountDepoisPrimeiro);
  });

  it('existsByNonce reflete o registro gravado', async () => {
    const ctx = setup();
    const link = await seedLink(ctx);
    const provider = makeProvider({ tokenBalance: 10_000_000n, nativeBalance: 10n ** 18n });
    const sweeper = makeSweeper(ctx, provider);

    await sweeper.runCycle();
    const movimentos = await ctx.repos.transfers.findByLink(link.id);
    const comNonce = movimentos.find((t) => t.nonce !== null);
    expect(comNonce).toBeDefined();
    expect(await ctx.repos.transfers.existsByNonce(link.id, comNonce!.nonce!)).toBe(true);
    expect(await ctx.repos.transfers.existsByNonce(link.id, 999)).toBe(false);
  });
});

describe('D2: devolve o gas nativo residual', () => {
  it('registra o retorno de dust para a carteira fria', async () => {
    const ctx = setup();
    const link = await seedLink(ctx);
    // Sobra bastante nativo apos o sweep do token.
    const provider = makeProvider({
      tokenBalance: 10_000_000n,
      nativeBalance: 10n ** 18n,
      dustNativeAfter: 0n,
    });
    const sweeper = makeSweeper(ctx, provider);

    await sweeper.runCycle();

    const movimentos = await ctx.repos.transfers.findByLink(link.id);
    const dust = movimentos.find((t) => t.erro === 'retorno de gas nativo (dust)');
    expect(dust).toBeDefined();
    expect(dust?.paraAddress).toBe(CARTEIRA);
    expect(dust?.valorBaseUnits).toBeGreaterThan(0n);
  });

  it('nao manda dust quando o saldo e menor que a reserva de gas', async () => {
    const ctx = setup();
    const link = await seedLink(ctx);
    // O gas do token e pago com 1e18; depois sobra 3e13, menos que a reserva
    // de 1,5x para o dust (3,15e13).
    const provider = makeProvider({
      tokenBalance: 10_000_000n,
      nativeBalance: 10n ** 18n,
      tokenNativeAfter: 30_000_000_000_000n,
    });
    const sweeper = makeSweeper(ctx, provider);

    await sweeper.runCycle();

    const movimentos = await ctx.repos.transfers.findByLink(link.id);
    const dust = movimentos.find((t) => t.erro === 'retorno de gas nativo (dust)');
    // Com 1 gwei, custoEnvio = 2,1e13 e reserva = 3,15e13 > saldo -> sem dust.
    expect(dust).toBeUndefined();
  });
});

describe('D5: gas sponsor sem saldo', () => {
  it('marca pago_sem_gas e registra o motivo', async () => {
    const ctx = setup();
    const link = await seedLink(ctx);
    // Endereco derivado sem gas e com patrocinador habilitado.
    const provider = makeProvider({ tokenBalance: 10_000_000n, nativeBalance: 0n });
    const sweeper = makeSweeper(ctx, provider, {
      sponsorEnabled: true,
      sponsorThrows: 'gas sponsor sem saldo: tem 0, precisa de 510000000000000000',
    });

    const r = await sweeper.runCycle();
    expect(r.aguardandoGas).toBe(1);

    const depois = await ctx.repos.links.findById(link.id);
    expect(depois?.status).toBe('pago_sem_gas');

    const movimentos = await ctx.repos.transfers.findByLink(link.id);
    const falho = movimentos.find((t) => t.status === 'falhou');
    expect(falho?.erro).toContain('gas sponsor sem saldo');
  });

  it('sem patrocinador configurado tambem vira pago_sem_gas', async () => {
    const ctx = setup();
    const link = await seedLink(ctx);
    const provider = makeProvider({ tokenBalance: 10_000_000n, nativeBalance: 0n });
    const sweeper = makeSweeper(ctx, provider);

    const r = await sweeper.runCycle();
    expect(r.aguardandoGas).toBe(1);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('pago_sem_gas');
  });
});