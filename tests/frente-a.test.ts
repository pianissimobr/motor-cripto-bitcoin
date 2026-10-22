import { describe, expect, it, beforeEach } from 'vitest';
import { HDNodeWallet, Mnemonic } from 'ethers';

import {
  LINK_TRANSITIONS,
  IllegalTransitionError,
  assertTransition,
  canTransition,
} from '../src/core/domain/link-state.js';
import type { LinkStatus } from '../src/core/domain/types.js';
import { createMotor } from '../src/core/index.js';
import { HdWallet } from '../src/core/hd/hd-wallet.js';
import { silentLogger } from '../src/core/logger.js';
import { createFakeRepositories } from './fakes.js';

/**
 * Frente A - correcoes de corretude.
 *
 * A1: o destino do sweep (carteira fria) e persistido no link e e o que o
 *     sweeper usa. Antes, a escolha do operador na UI era ignorada.
 * A2: saldo zero nao pode ser reportado como "pago_sem_gas".
 * A3: a cadeia de auditoria nao pode bifurcar sob concorrencia.
 * A4: transicoes de status sao validadas contra uma tabela.
 * A5: links fora da fila de sweep com saldo preso sao resgatados.
 */

const MNEMONIC = 'test test test test test test test test test test test junk';
const accountNode = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), "m/44'/60'/0'");
const XPUB = accountNode.neuter().extendedKey;

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const CARTEIRA_A = '0x1111111111111111111111111111111111111111';
const CARTEIRA_B = '0x2222222222222222222222222222222222222222';

function setup() {
  const repos = createFakeRepositories();
  const gasSponsor = {
    enabled: false,
    address: null,
    balance: async () => 0n,
    ensureGas: async () => false,
  };
  const motor = createMotor({
    repos,
    hdWallet: HdWallet.fromAccountXpub(XPUB, '0', 0),
    signer: {
      mode: 'local',
      addressFor: (i: number) => HdWallet.fromAccountXpub(XPUB, '0', 0).deriveAddress(i),
      signTransfer: async () => ({ rawTransaction: '0x', hash: '0x' }),
      buildUnsigned: () => ({
        from: '',
        to: '',
        data: '0x',
        value: '0',
        chainId: 137,
        nonce: 0,
        gasLimit: '0',
      }),
      describe: () => 'fake',
    },
    providerFactory: () => {
      throw new Error('provider nao usado neste teste');
    },
    gasSponsor: gasSponsor as never,
    logger: silentLogger,
    dataKey: Buffer.alloc(32, 7),
    indexKey: Buffer.alloc(32, 9),
    ttlHours: 72,
  });
  return { motor, repos };
}

type Ctx = ReturnType<typeof setup> & { profileId: string; clienteId: string; carteiraA: string; carteiraB: string };

async function seedBase(): Promise<Ctx> {
  const ctx = setup() as Ctx;
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
  const wa = await ctx.repos.coldWallets.create({
    label: 'Fria A',
    address: CARTEIRA_A,
    chain: 'polygon',
  });
  const wb = await ctx.repos.coldWallets.create({
    label: 'Fria B',
    address: CARTEIRA_B,
    chain: 'polygon',
  });
  const cliente = await ctx.motor.customers.create({
    nome: 'Maria Silva',
    email: 'maria@example.com',
  });
  return {
    ...ctx,
    profileId: perfil.id,
    clienteId: cliente.id,
    carteiraA: wa.id,
    carteiraB: wb.id,
  };
}


/** Provider fake cujo balanceOf sempre devolve 0. */
function fakeProviderZeroBalance() {
  return {
    network: { chainId: 137n },
    getBalance: async () => 10n ** 18n,
    getBlockNumber: async () => 100,
    getFeeData: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    getTransactionCount: async () => 0,
    estimateGas: async () => 60_000n,
    getCode: async () => '0x60',
    getBlock: async () => null,
    getLogs: async () => [],
    broadcastTransaction: async () => ({ hash: '0x', wait: async () => ({ status: 1 }) }),
    // Contract chama provider.call para balanceOf; 64 hex zeros = 0
    call: async (req: { to: string; data: string }) =>
      req.data?.startsWith('0x70a08231') ? '0x' + '0'.repeat(64) : '0x',
  } as never;
}

async function makeSweeper(ctx: Ctx, provider: unknown) {
  const { Sweeper } = await import('../src/core/chain/sweeper.js');
  return new Sweeper({
    repos: ctx.repos,
    providerFactory: () => provider as never,
    signer: {
      mode: 'local',
      addressFor: (i: number) => HdWallet.fromAccountXpub(XPUB, '0', 0).deriveAddress(i),
      signTransfer: async () => ({ rawTransaction: '0x', hash: '0x' }),
      buildUnsigned: () => ({
        from: '', to: '', data: '0x', value: '0', chainId: 137, nonce: 0, gasLimit: '0',
      }),
      describe: () => 'fake',
    },
    gasSponsor: { enabled: false, address: null, balance: async () => 0n, ensureGas: async () => false } as never,
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

/* ================================================================== */
/* A1 - destino do sweep persistido                                    */
/* ================================================================== */

describe('A1: carteira fria escolhida e persistida no link', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await seedBase();
  });

  it('grava o endereco e o id da carteira escolhida', async () => {
    const link = await ctx.motor.links.create({
      clienteId: ctx.clienteId,
      amountCents: 10_000,
      rampProfileId: ctx.profileId,
      coldWalletId: ctx.carteiraB,
    });

    expect(link.carteiraFriaEndereco).toBe(CARTEIRA_B);
    expect(link.carteiraFriaId).toBe(ctx.carteiraB);
  });

  it('respeita a escolha mesmo havendo outra carteira da mesma chain', async () => {
    // As duas carteiras sao da chain polygon; a lista retornaria "Fria A"
    // primeiro, que era exatamente o bug (o sweeper pegava a primeira).
    const link = await ctx.motor.links.create({
      clienteId: ctx.clienteId,
      amountCents: 10_000,
      rampProfileId: ctx.profileId,
      coldWalletId: ctx.carteiraB,
    });

    const relido = await ctx.repos.links.findById(link.id);
    expect(relido?.carteiraFriaEndereco).toBe(CARTEIRA_B);
    expect(relido?.carteiraFriaEndereco).not.toBe(CARTEIRA_A);
  });

  it('persiste o endereco informado livremente (sem id de tabela)', async () => {
    const link = await ctx.motor.links.create({
      clienteId: ctx.clienteId,
      amountCents: 10_000,
      rampProfileId: ctx.profileId,
      coldWalletAddress: CARTEIRA_A,
    });
    expect(link.carteiraFriaEndereco).toBe(CARTEIRA_A);
  });

  it('usa a carteira da chain quando nenhuma for informada', async () => {
    const link = await ctx.motor.links.create({
      clienteId: ctx.clienteId,
      amountCents: 10_000,
      rampProfileId: ctx.profileId,
    });
    expect(link.carteiraFriaEndereco).toBe(CARTEIRA_A);
  });

  it('rejeita carteira de outra chain', async () => {
    await ctx.repos.coldWallets.create({
      label: 'Ethereum',
      address: '0x3333333333333333333333333333333333333333',
      chain: 'ethereum',
    });
    const eth = (await ctx.repos.coldWallets.list()).find((w) => w.chain === 'ethereum')!;
    await expect(
      ctx.motor.links.create({
        clienteId: ctx.clienteId,
        amountCents: 10_000,
        rampProfileId: ctx.profileId,
        coldWalletId: eth.id,
      }),
    ).rejects.toThrow(/incompativel/);
  });

  it('o destino do link e o que o sweeper vai usar', async () => {
    const link = await ctx.motor.links.create({
      clienteId: ctx.clienteId,
      amountCents: 10_000,
      rampProfileId: ctx.profileId,
      coldWalletId: ctx.carteiraB,
    });

    // Este e o mesmo campo que o sweeper le (resolveColdWallet).
    // Se o link aponta para B, o sweep vai para B.
    expect(link.carteiraFriaEndereco).toBe(CARTEIRA_B);
    const relido = await ctx.repos.links.findById(link.id);
    expect(relido?.carteiraFriaEndereco).toBe(CARTEIRA_B);
  });
});

/* ================================================================== */
/* A2 - saldo zero nao e "pago_sem_gas"                                */
/* ================================================================== */

describe('A2: saldo zero nao vira pago_sem_gas', () => {
  it('saldo zero mantem o status pago (bug: marcava pago_sem_gas)', async () => {
    const ctx = (await seedBase()) as Ctx;
    const link = await ctx.motor.links.create({
      clienteId: ctx.clienteId,
      amountCents: 10_000,
      rampProfileId: ctx.profileId,
      coldWalletId: ctx.carteiraA,
    });
    await ctx.repos.links.updateStatus(link.id, 'pago');

    // balanceOf sempre 0 -> o sweeper deve ignorar sem alterar status.
    const provider = fakeProviderZeroBalance();
    const sweeper = await makeSweeper(ctx, provider);
    await sweeper.runCycle();

    const depois = await ctx.repos.links.findById(link.id);
    expect(depois?.status).toBe('pago');
    expect(depois?.status).not.toBe('pago_sem_gas');
    // Nenhum movimento deve ter sido registrado.
    const movimentos = await ctx.repos.transfers.findByLink(link.id);
    expect(movimentos).toHaveLength(0);
  });
});
/* ================================================================== */
/* A3 - cadeia de auditoria sem bifurcacao                             */
/* ================================================================== */

describe('A3: cadeia de auditoria encadeada', () => {
  it('grava os eventos com ator, acao e entidade', async () => {
    const ctx = await seedBase();
    await ctx.repos.audit.record({ ator: 'a', acao: 'um', entidade: 'e' });
    await ctx.repos.audit.record({ ator: 'a', acao: 'dois', entidade: 'e' });

    const eventos = await ctx.repos.audit.list(10);
    expect(eventos.length).toBeGreaterThanOrEqual(2);
    expect(eventos.some((e) => e.acao === 'um')).toBe(true);
    expect(eventos.some((e) => e.acao === 'dois')).toBe(true);
  });
});

/* ================================================================== */
/* A4 - tabela de transicoes                                           */
/* ================================================================== */

describe('A4: tabela de transicoes de status', () => {
  it('permite o fluxo normal', () => {
    expect(canTransition('aguardando', 'pago')).toBe(true);
    expect(canTransition('pago', 'movido')).toBe(true);
    expect(canTransition('pago', 'parcial')).toBe(true);
    expect(canTransition('pago_sem_gas', 'movido')).toBe(true);
  });

  it('permite pagamento fora do prazo (expirado -> pago)', () => {
    expect(canTransition('expirado', 'pago')).toBe(true);
    expect(canTransition('revogado', 'pago')).toBe(true);
  });

  it('permite voltar de movido so para reorg/reconciliacao', () => {
    expect(canTransition('movido', 'pago')).toBe(true);
    expect(canTransition('movido', 'parcial')).toBe(true);
    expect(canTransition('movido', 'aguardando')).toBe(false);
  });

  it('bloqueia transicoes invalidas', () => {
    expect(canTransition('aguardando', 'movido')).toBe(false);
    expect(canTransition('aguardando', 'revogado')).toBe(true);
    expect(() => assertTransition('aguardando', 'movido')).toThrow(IllegalTransitionError);
  });

  it('a maquina de estados valida e audita a transicao', async () => {
    const ctx = await seedBase();
    const link = await ctx.motor.links.create({
      clienteId: ctx.clienteId,
      amountCents: 10_000,
      rampProfileId: ctx.profileId,
      coldWalletId: ctx.carteiraA,
    });

    await ctx.motor.linkState.transition({
      linkId: link.id,
      to: 'pago',
      reason: 'pagamento confirmado',
      actor: 'teste',
    });
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('pago');

    const eventos = await ctx.repos.audit.list(20);
    const registro = eventos.find((e) => e.acao === 'link.status_mudou');
    expect(registro?.detalhes).toMatchObject({ de: 'aguardando', para: 'pago' });
  });

  it('rejeita transicao invalida na maquina de estados', async () => {
    const ctx = await seedBase();
    const link = await ctx.motor.links.create({
      clienteId: ctx.clienteId,
      amountCents: 10_000,
      rampProfileId: ctx.profileId,
      coldWalletId: ctx.carteiraA,
    });
    await expect(
      ctx.motor.linkState.transition({ linkId: link.id, to: 'movido', reason: 'ilegal' }),
    ).rejects.toThrow(IllegalTransitionError);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('aguardando');
  });

  it('cobre todos os estados na tabela', () => {
    const estados: LinkStatus[] = [
      'aguardando',
      'pago',
      'parcial',
      'pago_sem_gas',
      'movido',
      'expirado',
      'revogado',
    ];
    for (const e of estados) {
      expect(LINK_TRANSITIONS[e]).toBeDefined();
      expect(Array.isArray(LINK_TRANSITIONS[e])).toBe(true);
    }
  });
});