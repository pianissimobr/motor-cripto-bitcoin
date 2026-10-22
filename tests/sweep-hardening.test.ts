import { describe, expect, it } from 'vitest';
import { keccak256 } from 'ethers';

import { encodeTransfer } from '../src/core/chain/erc20.js';
import { PsbtSigner } from '../src/core/signer/psbt-signer.js';
import { HdWallet } from '../src/core/hd/hd-wallet.js';
import {
  CARTEIRA,
  XPUB,
  USDC,
  createFakeChain,
  createTestSigner,
  makeHarnessSweeper,
  seedPaidLink,
  setupSweepContext,
} from './sweep-harness.js';

async function inFlightRaw(nonce: number, valor: bigint) {
  const signer = createTestSigner();
  return signer.signTransfer({
    index: 0,
    to: USDC,
    data: encodeTransfer(CARTEIRA, valor),
    value: 0n,
    chainId: 137,
    nonce,
    gasLimit: 72_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
}

describe('sweep hardening', () => {
  it('faz um segundo sweep depois de um dust no nonce anterior', async () => {
    const ctx = setupSweepContext();
    const link = await seedPaidLink(ctx);
    const chain = createFakeChain({
      tokenBalance: 10_000_000n,
      nativeBalance: 10n ** 18n,
      dustNativeAfter: 0n,
    });
    const sweeper = makeHarnessSweeper(ctx, chain.provider);

    const primeiro = await sweeper.runCycle();
    expect(primeiro.movidos).toBe(1);

    const depoisPrimeiro = await ctx.repos.transfers.findByLink(link.id);
    const token = depoisPrimeiro.find((t) => t.kind === 'sweep');
    const dust = depoisPrimeiro.find((t) => t.kind === 'dust');
    expect(token).toBeDefined();
    expect(dust).toBeDefined();
    expect(dust?.nonce).toBe((token?.nonce ?? -1) + 1);

    // Segundo pagamento no mesmo endereco. O dust ja consumiu um nonce;
    // o novo sweep precisa usar o nonce seguinte, nao o do dust.
    chain.estado.tokenBalance = 10_000_000n;
    chain.estado.nativeBalance = 10n ** 18n;
    // O monitor marcaria o link como pago ao detectar o segundo deposito.
    await ctx.repos.links.updateStatus(link.id, 'pago');

    const segundo = await sweeper.runCycle();
    expect(segundo.movidos).toBe(1);

    const sweeps = (await ctx.repos.transfers.findByLink(link.id)).filter(
      (t) => t.kind === 'sweep',
    );
    expect(sweeps).toHaveLength(2);
    expect(sweeps[1]!.nonce).toBe((dust?.nonce ?? -1) + 1);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('movido');
  });

  it('retoma uma raw persistida antes do broadcast (crash antes de enviar)', async () => {
    const ctx = setupSweepContext();
    const link = await seedPaidLink(ctx);
    const raw = await inFlightRaw(0, 10_000_000n);
    await ctx.repos.transfers.create({
      linkId: link.id,
      deAddress: link.enderecoDeposito,
      paraAddress: CARTEIRA,
      valorBaseUnits: 10_000_000n,
      txHash: keccak256(raw.rawTransaction),
      rawTransaction: raw.rawTransaction,
      status: 'pendente',
      chain: 'polygon',
      bloco: null,
      nonce: 0,
      kind: 'sweep',
    });

    const chain = createFakeChain({
      tokenBalance: 10_000_000n,
      nativeBalance: 10n ** 18n,
      nonceLatest: 0,
    });
    const sweeper = makeHarnessSweeper(ctx, chain.provider);
    const r = await sweeper.runCycle();

    expect(r.movidos).toBe(1);
    expect(chain.estado.broadcasts.filter((b) => b === raw.rawTransaction)).toHaveLength(1);
    const sweeps = (await ctx.repos.transfers.findByLink(link.id)).filter(
      (t) => t.kind === 'sweep',
    );
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.status).toBe('confirmado');
  });

  it('nao reenvia quando a transacao ja tem recibo (crash apos broadcast)', async () => {
    const ctx = setupSweepContext();
    const link = await seedPaidLink(ctx);
    const raw = await inFlightRaw(0, 10_000_000n);
    const hash = keccak256(raw.rawTransaction);
    await ctx.repos.transfers.create({
      linkId: link.id,
      deAddress: link.enderecoDeposito,
      paraAddress: CARTEIRA,
      valorBaseUnits: 10_000_000n,
      txHash: hash,
      rawTransaction: raw.rawTransaction,
      status: 'enviado',
      chain: 'polygon',
      bloco: null,
      nonce: 0,
      kind: 'sweep',
    });

    const chain = createFakeChain({
      tokenBalance: 0n,
      nativeBalance: 0n,
      nonceLatest: 1,
    });
    chain.estado.receipts.set(hash, {
      status: 1,
      blockNumber: 1000,
      gasUsed: 50_000n,
    });
    const sweeper = makeHarnessSweeper(ctx, chain.provider);
    const r = await sweeper.runCycle();

    expect(r.movidos).toBe(1);
    expect(chain.estado.broadcasts).toHaveLength(0);
    const sweep = (await ctx.repos.transfers.findByLink(link.id)).find(
      (t) => t.kind === 'sweep',
    );
    expect(sweep?.status).toBe('confirmado');
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('movido');
  });

  it('recupera sinteticamente saldo zero com nonce consumido sem registro', async () => {
    const ctx = setupSweepContext();
    const link = await seedPaidLink(ctx);
    const chain = createFakeChain({
      tokenBalance: 0n,
      nativeBalance: 0n,
      nonceLatest: 1,
    });
    const sweeper = makeHarnessSweeper(ctx, chain.provider);
    const r = await sweeper.runCycle();

    expect(r.movidos).toBe(1);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('movido');
    const recovery = (await ctx.repos.transfers.findByLink(link.id)).find(
      (t) => t.kind === 'recovery',
    );
    expect(recovery).toBeDefined();
    expect(recovery?.status).toBe('confirmado');
    expect(recovery?.txHash).toBeNull();
    expect(recovery?.nonce).toBe(0);
  });

  it('usa o gas estimado do ERC-20, nao 21000, para decidir patrocinio', async () => {
    const ctx = setupSweepContext();
    const link = await seedPaidLink(ctx);
    // 3e13 paga 21000 gas a 1 gwei, mas nao paga o gas estimado com buffer
    // (60000 * 1.2 * 1 gwei = 7.2e13).
    const chain = createFakeChain({
      tokenBalance: 10_000_000n,
      nativeBalance: 30_000_000_000_000n,
    });
    const sweeper = makeHarnessSweeper(ctx, chain.provider);
    const r = await sweeper.runCycle();

    expect(r.aguardandoGas).toBe(1);
    expect(chain.estado.broadcasts).toHaveLength(0);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('pago_sem_gas');
  });

  it('PSBT persiste unsigned, aceita raw assinado e retoma a confirmacao', async () => {
    const ctx = setupSweepContext();
    const link = await seedPaidLink(ctx);
    const wallet = HdWallet.fromAccountXpub(XPUB, '0', 0);
    const psbt = new PsbtSigner((index) => wallet.deriveAddress(index));
    const chain = createFakeChain({
      tokenBalance: 10_000_000n,
      nativeBalance: 10n ** 18n,
    });
    const sweeper = makeHarnessSweeper(ctx, chain.provider, { signer: psbt });

    const primeiro = await sweeper.runCycle();
    expect(primeiro.aguardandoAssinatura).toBe(1);
    expect(chain.estado.broadcasts).toHaveLength(0);

    const transfer = (await ctx.repos.transfers.findByLink(link.id)).find(
      (t) => t.kind === 'sweep',
    );
    expect(transfer?.status).toBe('pendente');
    expect(transfer?.unsignedTransaction).not.toBeNull();
    const unsigned = JSON.parse(transfer!.unsignedTransaction!) as {
      to: string;
      data: string;
      value: string;
      chainId: number;
      nonce: number;
      gasLimit: string;
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
    };

    const assinado = await createTestSigner().signTransfer({
      index: 0,
      to: unsigned.to,
      data: unsigned.data,
      value: BigInt(unsigned.value),
      chainId: unsigned.chainId,
      nonce: unsigned.nonce,
      gasLimit: BigInt(unsigned.gasLimit),
      maxFeePerGas: BigInt(unsigned.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(unsigned.maxPriorityFeePerGas),
    });
    const enviado = await sweeper.submitSignedTransfer(transfer!.id, assinado.rawTransaction);
    expect(enviado.status).toBe('enviado');
    expect(chain.estado.broadcasts).toHaveLength(1);

    const segundo = await sweeper.runCycle();
    expect(segundo.movidos).toBe(1);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('movido');
  });

  it('PSBT recusa raw que nao corresponde a unsigned', async () => {
    const ctx = setupSweepContext();
    const link = await seedPaidLink(ctx);
    const wallet = HdWallet.fromAccountXpub(XPUB, '0', 0);
    const chain = createFakeChain({ tokenBalance: 10_000_000n });
    const sweeper = makeHarnessSweeper(ctx, chain.provider, {
      signer: new PsbtSigner((index) => wallet.deriveAddress(index)),
    });
    await sweeper.runCycle();
    const transfer = (await ctx.repos.transfers.findByLink(link.id)).find(
      (t) => t.kind === 'sweep',
    )!;

    const outro = await createTestSigner().signTransfer({
      index: 0,
      to: USDC,
      data: encodeTransfer(CARTEIRA, 1_000_000n),
      value: 0n,
      chainId: 137,
      nonce: 0,
      gasLimit: 120_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });

    await expect(
      sweeper.submitSignedTransfer(transfer.id, outro.rawTransaction),
    ).rejects.toThrow(/rawTransaction invalido/);
    expect(chain.estado.broadcasts).toHaveLength(0);
  });

  it('dust revertido nao desfaz o sweep do token', async () => {
    const ctx = setupSweepContext();
    const link = await seedPaidLink(ctx);
    const chain = createFakeChain({
      tokenBalance: 10_000_000n,
      nativeBalance: 10n ** 18n,
      dustReceiptStatus: 0,
      dustNativeAfter: 0n,
    });
    const sweeper = makeHarnessSweeper(ctx, chain.provider);
    const r = await sweeper.runCycle();

    expect(r.movidos).toBe(1);
    expect((await ctx.repos.links.findById(link.id))?.status).toBe('movido');
    const dust = (await ctx.repos.transfers.findByLink(link.id)).find(
      (t) => t.kind === 'dust',
    );
    expect(dust?.status).toBe('falhou');
  });
});
