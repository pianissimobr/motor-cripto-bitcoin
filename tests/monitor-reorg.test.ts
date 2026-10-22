import { describe, expect, it } from 'vitest';

import { BlockchainMonitor } from '../src/core/chain/monitor.js';
import { silentLogger } from '../src/core/logger.js';
import type { ReorgCheck } from '../src/core/chain/reorg-detector.js';
import { seedPaidLink, setupSweepContext } from './sweep-harness.js';

function makeProvider() {
  return {
    network: { chainId: 137n },
    getBlockNumber: async () => 0,
    getBlock: async (n: number | string) => {
      const number = Number(n);
      return Number.isFinite(number) ? { number, hash: `0xblk${number}` } : null;
    },
    getLogs: async () => [],
    call: async () => '0x' + '0'.repeat(64),
    getBalance: async () => 0n,
    getTransactionCount: async () => 0,
  };
}

function makeMonitor(
  ctx: ReturnType<typeof setupSweepContext>,
  check: ReorgCheck,
  overrides: { startBlock?: number } = {},
) {
  const provider = makeProvider();
  const monitor = new BlockchainMonitor({
    repos: ctx.repos,
    providerFactory: () => provider as never,
    logger: silentLogger,
    linkState: ctx.motor.linkState,
    reorgDetector: {
      check: async () => check,
      maybeAnchor: async () => {},
    } as never,
    options: {
      confirmationsRequired: 1,
      tolerancePct: 1,
      maxTopics: 200,
      blockRange: 2000,
      startBlock: overrides.startBlock ?? 0,
      blockTag: 'latest',
      anchorInterval: 32,
      maxReorgAnchors: 64,
    },
  });
  return { monitor, provider };
}

async function seedConfirmedPayment(ctx: ReturnType<typeof setupSweepContext>) {
  const link = await seedPaidLink(ctx);
  const payment = await ctx.repos.payments.upsert({
    linkId: link.id,
    txHash: `0x${'ab'.repeat(32)}`,
    logIndex: 0,
    deAddress: '0x2222222222222222222222222222222222222222',
    paraAddress: link.enderecoDeposito,
    token: 'USDC',
    valorBaseUnits: 10_000_000n,
    bloco: 100,
    status: 'detectado',
    detectadoEm: new Date(),
  });
  await ctx.repos.payments.confirm({
    paymentId: payment.id,
    confirmacoes: 10,
    credit: {
      clienteId: link.clienteId,
      linkId: link.id,
      pagamentoId: payment.id,
      valorBaseUnits: payment.valorBaseUnits,
      valorCentavos: 1000,
      moeda: 'USDC',
      status: 'liberado',
    },
  });
  return { link, payment };
}

const REORG_SAFE_50: ReorgCheck = {
  reorg: true,
  blocoSeguro: 50,
  ancorasTestadas: 1,
  reconstrucaoTotal: false,
  mensagem: 'ancestral comum no bloco 50',
};

describe('monitor: reorg e credito', () => {
  it('preserva expirado quando o pagamento tardio e revertido', async () => {
    const ctx = setupSweepContext();
    const { link, payment } = await seedConfirmedPayment(ctx);
    await ctx.repos.links.updateStatus(link.id, 'expirado');

    const { monitor } = makeMonitor(ctx, REORG_SAFE_50);
    const r = await monitor.runCycle();

    expect(r.reorgsDetectados).toBe(1);
    expect(r.pagamentosRevogados).toBe(1);
    expect(r.creditosRevogados).toBe(1);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('expirado');
    expect((await ctx.repos.payments.findByTxHash(payment.txHash))?.status).toBe('revertido');
    expect((await ctx.repos.credits.findByPayment(payment.id))?.status).toBe('revertido');
  });

  it('volta para aguardando quando o link afetado nao e terminal', async () => {
    const ctx = setupSweepContext();
    const { link } = await seedConfirmedPayment(ctx);

    const { monitor } = makeMonitor(ctx, REORG_SAFE_50);
    await monitor.runCycle();

    expect((await ctx.repos.links.findById(link.id))?.status).toBe('aguardando');
  });

  it('nao rewinda antes de MONITOR_START_BLOCK em reorg profundo', async () => {
    const ctx = setupSweepContext();
    const { link, payment } = await seedConfirmedPayment(ctx);
    const deep: ReorgCheck = {
      ...REORG_SAFE_50,
      blocoSeguro: 64,
      reconstrucaoTotal: true,
      mensagem: 'reorg profundo',
    };

    const { monitor } = makeMonitor(ctx, deep, { startBlock: 1000 });
    await monitor.runCycle();

    const cursor = await ctx.repos.cursors.get('polygon', link.tokenContract);
    expect(cursor?.ultimoBloco).toBe(999);
    // O pagamento esta abaixo do piso operacional e nao foi tocado.
    expect((await ctx.repos.payments.findByTxHash(payment.txHash))?.status).toBe('confirmado');
  });

  it('re-detecta no novo bloco e restaura o credito revertido', async () => {
    const ctx = setupSweepContext();
    const { link, payment } = await seedConfirmedPayment(ctx);

    await ctx.repos.payments.revertAboveBlock('polygon', 99);
    await ctx.repos.credits.revertByPaymentIds([payment.id]);

    const reencontrado = await ctx.repos.payments.upsert({
      linkId: link.id,
      txHash: payment.txHash,
      logIndex: payment.logIndex,
      deAddress: payment.deAddress,
      paraAddress: payment.paraAddress,
      token: payment.token,
      valorBaseUnits: payment.valorBaseUnits,
      bloco: 105,
      status: 'detectado',
      detectadoEm: new Date(),
    });
    expect(reencontrado.bloco).toBe(105);
    expect(reencontrado.status).toBe('detectado');
    expect(reencontrado.confirmacoes).toBe(0);

    await ctx.repos.payments.confirm({
      paymentId: payment.id,
      confirmacoes: 10,
      credit: {
        clienteId: link.clienteId,
        linkId: link.id,
        pagamentoId: payment.id,
        valorBaseUnits: payment.valorBaseUnits,
        valorCentavos: 1000,
        moeda: 'USDC',
        status: 'liberado',
      },
    });

    expect((await ctx.repos.payments.findByTxHash(payment.txHash))?.status).toBe('confirmado');
    expect((await ctx.repos.credits.findByPayment(payment.id))?.status).toBe('liberado');
  });
});
