import { describe, expect, it } from 'vitest';
import { SwapService } from '../src/services/swap-service.js';
import { silentLogger } from '../src/logger.js';
import { testConfig } from './helpers.js';
import type { SwapKitClient } from '../src/adapters/swapkit/client.js';
import type { Repositories } from '../src/db/repositories.js';
import type { SwapOrder } from '../src/domain/types.js';

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const DESTINATION = '0xe49FBc85D36B37Ea85895c339aA9044b0D2B7ce6';
const DEPOSIT = 'bc1qexemploenderecodeposito';

type FakeOrder = SwapOrder;

function order(overrides: Partial<SwapOrder> = {}): FakeOrder {
  const now = new Date('2026-11-07T00:00:00.000Z');
  return {
    id: '22222222-2222-2222-2222-222222222222',
    clientId: CLIENT_ID,
    externalId: 'pedido_1',
    provider: 'swapkit',
    providerOrderId: null,
    providerState: null,
    status: 'criando',
    amountFiatCents: 10_000n,
    currency: 'BRL',
    amountSats: 200_000n,
    sellAsset: 'BTC.BTC',
    buyAsset: 'POL.USDC-0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    network: 'polygon',
    destinationAddress: DESTINATION,
    depositAddress: null,
    sourceAddress: null,
    depositChannelId: null,
    expectedAssetMinor: null,
    startBlock: null,
    deliveryTxHash: null,
    deliveryLogIndex: null,
    feeTotalBps: null,
    expiresAt: null,
    providerPayload: null,
    error: null,
    attempts: 0,
    lastCheckedAt: null,
    metadata: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type Harness = {
  service: SwapService;
  rows: FakeOrder[];
  calls: { quote: number; swap: number; track: number };
  /** Altura da rede falsa (o pedido nasce em 1.000; o teste avanca). */
  chain: { height: bigint };
};

function build(
  options: {
    quoteRoutes?: unknown;
    swapMeta?: Record<string, unknown>;
    trackStatus?: string;
    existing?: FakeOrder | null;
    verification?: 'ok' | 'pending' | 'invalid';
    /** Usa o verificador real contra esta "rede" (logs de Transfer para o destino). */
    transfers?: { txHash: string; logIndex: number; value: bigint; block: bigint }[];
    trackHash?: string | null;
    utxos?: Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean } }>;
  } = {},
): Harness {
  const rows: FakeOrder[] = [];
  const calls = { quote: 0, swap: 0, track: 0 };
  let stored = options.existing ?? null;

  const claimed = new Set<string>();
  const chain = { height: 1_000n };
  const repos = {
    isSwapDeliveryClaimed: async (txHash: string, logIndex: number) => claimed.has(`${txHash.toLowerCase()}:${logIndex}`),
    claimSwapDelivery: async (id: string, txHash: string, logIndex: number) => {
      const key = `${txHash.toLowerCase()}:${logIndex}`;
      const row = rows.find((r) => r.id === id);
      if (!row || row.deliveryTxHash || claimed.has(key)) return false;
      claimed.add(key);
      row.deliveryTxHash = txHash.toLowerCase();
      row.deliveryLogIndex = logIndex;
      return true;
    },
    findSwapOrderByClientAndExternalId: async (_clientId: string, externalId: string) =>
      stored && stored.externalId === externalId ? stored : null,
    createSwapOrder: async (input: Record<string, unknown>) => {
      const created = order({
        id: String(input.id),
        externalId: String(input.externalId),
        amountSats: input.amountSats as bigint,
        amountFiatCents: input.amountFiatCents as bigint,
        currency: input.currency as 'BRL',
        destinationAddress: String(input.destinationAddress),
      });
      rows.push(created);
      stored = created;
      return created;
    },
    updateSwapOrder: async (input: Record<string, unknown>) => {
      const current = rows.find((row) => row.id === input.id) ?? stored;
      if (!current) return null;
      const updated = { ...current, ...input } as FakeOrder;
      const index = rows.findIndex((row) => row.id === input.id);
      if (index >= 0) rows[index] = updated;
      else rows.push(updated);
      stored = updated;
      return updated;
    },
    findSwapOrderById: async (id: string) =>
      rows.find((row) => row.id === id) ?? (stored?.id === id ? stored : null),
    findClientById: async () => ({
      id: CLIENT_ID,
      settlementAddress: DESTINATION,
      spreadBps: 0,
    }),
    findActiveUsdcSettlementWalletForClient: async () => null,
    isAddressRevoked: async () => false,
    findMerchantWalletByChainAddress: async () => null,
    listSwapOrdersToReconcile: async () => rows,
    findOpenSwapOrderByAmountSats: async (amountSats: bigint) =>
      rows.find(
        (row) =>
          row.amountSats === amountSats &&
          ['criando', 'pendente', 'aguardando_deposito', 'depositado', 'trocado', 'incerto'].includes(
            row.status,
          ),
      ) ?? null,
  } as unknown as Repositories;

  const swapkit = {
    quote: async () => {
      calls.quote += 1;
      return (
        options.quoteRoutes ?? {
          quoteId: 'q_1',
          routes: [
            {
              routeId: 'route_1',
              providers: ['NEAR'],
              buyAsset: 'POL.USDC-0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
              expectedBuyAmount: '99.5',
              fees: [{ amountBps: 15 }],
            },
          ],
        }
      );
    },
    swap: async () => {
      calls.swap += 1;
      return {
        swapId: 'swap_1',
        routeId: 'route_1',
        txType: 'psbt',
        txHint: 'simpleTransfer',
        // O endereco de deposito vem no `inboundAddress`.
        inboundAddress: DEPOSIT,
        expectedBuyAmount: '99.5',
        meta: {
          providerDepositChannelId: 'dc_1',
          depositChannelExpiration: 1_800_000_000,
          ...(options.swapMeta ?? {}),
        },
      };
    },
    track: async () => {
      calls.track += 1;
      return { status: options.trackStatus ?? 'completed', hash: options.trackHash ?? null };
    },
    rateLimiter: { cooldownRemaining: () => 0 },
  } as unknown as SwapKitClient;

  const config = testConfig({
    SWAPKIT_ENABLED: 'true',
    SWAPKIT_API_KEY: 'sk_test',
    SWAPKIT_SOURCE_ADDRESS: 'bc1qgkju4yvvtuz0s8vqn837q396jezu2h8ex7gk98',
    PIX_ENABLED: 'true',
    LUNIUM_API_KEY: 'lun_test_key',
    LUNIUM_WEBHOOK_SECRET: 'whk_test',
  });

  const fx = {
    createQuote: async (input: { amountFiatCents: bigint }) => ({
      id: 'fx_1',
      amountIn: input.amountFiatCents,
      amountOut: 200_000n,
      baseCurrency: 'BRL',
    }),
  } as never;

  const verification = options.verification ?? 'pending';

  const esplora = {
    getAddressUtxos: async () => options.utxos ?? [],
  };

  const service = new SwapService({
    repos,
    swapkit,
    config,
    logger: silentLogger,
    fx,
    esplora: esplora as never,
    deliveryChain: {
      getBlockNumber: async () => chain.height,
      getTransactionReceipt: async () => {
        throw new Error('sem receipt no teste');
      },
      getTransferLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
        (options.transfers ?? [])
          .filter((t) => t.block >= fromBlock && t.block <= toBlock)
          .map((t) => ({ transactionHash: t.txHash, logIndex: t.logIndex, value: t.value, blockNumber: t.block })),
    },
    ...(options.transfers
      ? {}
      : {
          verifyDelivery: async () =>
            verification === 'ok'
              ? { kind: 'ok' as const, detail: 'ok', proof: { txHash: `0x${'a'.repeat(64)}`, logIndex: 0, valueMinor: 1n } }
              : verification === 'invalid'
                ? { kind: 'invalid' as const, detail: 'sem prova' }
                : { kind: 'pending' as const, detail: 'ainda nao' },
        }),
  });

  return { service, rows, calls, chain };
}

describe('SwapService', () => {
  it('cria o pedido, devolve o endereco de deposito e o BIP21', async () => {
    const { service, rows, calls } = build();
    const result = await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });

    expect(calls.quote).toBe(1);
    expect(calls.swap).toBe(1);
    expect(result.dto.status).toBe('aguardando_deposito');
    expect(result.dto.bitcoin.address).toBe(DEPOSIT);
    expect(result.dto.bitcoin.bip21).toContain(`bitcoin:${DEPOSIT}`);
    expect(result.dto.bitcoin.bip21).toContain('amount=0.002');
    expect(result.dto.bitcoin.qr_svg).toBeTruthy();
    expect(rows[0]?.expectedAssetMinor).toBe(99_500_000n);
  });

  it('o mesmo external_id nao abre um segundo pedido', async () => {
    const { service, calls } = build();
    const first = await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });
    expect(first.reused).toBe(false);

    const second = await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });
    expect(second.reused).toBe(true);
    expect(calls.quote).toBe(1);
  });

  it('sem rota na SwapKit, o pedido fica com erro e o erro sobe', async () => {
    const { service, rows } = build({
      quoteRoutes: { routes: [], providerErrors: [{ provider: 'NEAR', message: 'min amount' }] },
    });
    await expect(
      service.create({
        clientId: CLIENT_ID,
        externalId: 'pedido_1',
        amountFiatCents: 10_000n,
        currency: 'BRL',
      }),
    ).rejects.toThrow(/nao achou rota/);
    expect(rows[0]?.status).toBe('falhou');
    expect(rows[0]?.error).toContain('min amount');
  });

  it('recusa o valor fora da faixa', async () => {
    const { service } = build();
    await expect(
      service.create({
        clientId: CLIENT_ID,
        externalId: 'pedido_1',
        amountFiatCents: 1n,
        currency: 'BRL',
      }),
    ).rejects.toThrow(/minimo/);
  });

  it('so marca liquidado com prova on-chain', async () => {
    const { service, rows } = build({ trackStatus: 'completed', verification: 'ok' });
    await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });
    const synced = await service.sync(rows[0]!.id);
    expect(synced?.status).toBe('liquidado');
  });

  it('sem prova, o pedido nao vira liquidado', async () => {
    const { service, rows } = build({ trackStatus: 'completed', verification: 'pending' });
    await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });
    const synced = await service.sync(rows[0]!.id);
    expect(synced?.status).toBe('trocado');
  });

  it('prova invalida leva o pedido para manual', async () => {
    const { service, rows } = build({ trackStatus: 'completed', verification: 'invalid' });
    await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });
    const synced = await service.sync(rows[0]!.id);
    expect(synced?.status).toBe('manual');
  });

  it('o valor do pedido e unico entre os pedidos abertos', async () => {
    // O provedor deriva o endereco de deposito do valor: dois pedidos com o
    // mesmo valor cairiam no mesmo endereco.
    const { service, rows } = build();
    await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });
    const first = rows[0]!;
    expect(first.amountSats).toBe(200_000n);

    const second = await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_2',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });
    expect(second.dto.amount_sats).not.toBe(first.amountSats.toString());
  });

  it('ve o deposito do pagador na chain', async () => {
    const { service, rows } = build({
      utxos: [{ txid: 'tx1', vout: 0, value: 200_000, status: { confirmed: true } }],
    });
    await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });

    const result = await service.watchDeposits(10);
    expect(result.seen).toBe(1);
    expect(rows[0]?.status).toBe('depositado');
    const deposit = (rows[0]?.providerPayload as { deposit?: { txid?: string } } | null)?.deposit;
    expect(deposit?.txid).toBe('tx1');
  });

  it('acompanha o estado do provedor sem chamar a chain', async () => {
    const { service, rows } = build({ trackStatus: 'awaiting_deposit' });
    await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
    });
    const synced = await service.sync(rows[0]!.id);
    expect(synced?.status).toBe('aguardando_deposito');
    expect(synced?.providerState).toBe('awaiting_deposit');
  });

  describe('prova de entrega sem hash (verificador real)', () => {
    const TX1 = `0x${'1'.repeat(64)}`;
    const TX2 = `0x${'2'.repeat(64)}`;
    // Cotado 99,5 USDC; slippage padrao 1% -> minimo 98,505.
    const create = async (service: SwapService, externalId: string) =>
      (await service.create({ clientId: CLIENT_ID, externalId, amountFiatCents: 10_000n, currency: 'BRL' })).dto.id;

    it('grava o bloco inicial do pedido (nao a metadata do cliente)', async () => {
      const { service, rows } = build({ transfers: [] });
      await service.create({
        clientId: CLIENT_ID,
        externalId: 'p1',
        amountFiatCents: 10_000n,
        currency: 'BRL',
        metadata: { balance_before_minor: '0' },
      });
      expect(rows[0]?.startBlock).toBe(1_000n);
    });

    it('uma transferencia prova um pedido so (dois pedidos para o mesmo destino)', async () => {
      const { service, rows, chain } = build({ transfers: [{ txHash: TX1, logIndex: 3, value: 99_500_000n, block: 1_010n }] });
      const a = await create(service, 'p1');
      const b = await create(service, 'p2');
      chain.height = 1_100n;
      expect((await service.sync(a))?.status).toBe('liquidado');
      expect((await service.sync(b))?.status).toBe('trocado');
      expect(rows.find((r) => r.id === a)?.deliveryTxHash).toBe(TX1);
      expect(rows.find((r) => r.id === b)?.deliveryTxHash).toBeNull();
    });

    it('com duas entregas, cada pedido fica com a sua', async () => {
      const { service, chain } = build({
        transfers: [
          { txHash: TX1, logIndex: 0, value: 99_500_000n, block: 1_010n },
          { txHash: TX2, logIndex: 0, value: 99_400_000n, block: 1_020n },
        ],
      });
      const a = await create(service, 'p1');
      const b = await create(service, 'p2');
      chain.height = 1_100n;
      expect((await service.sync(a))?.status).toBe('liquidado');
      expect((await service.sync(b))?.status).toBe('liquidado');
    });

    it('aceita a entrega dentro do slippage e recusa abaixo dele', async () => {
      const dentro = build({ transfers: [{ txHash: TX1, logIndex: 0, value: 98_600_000n, block: 1_010n }] });
      const d = await create(dentro.service, 'p1');
      dentro.chain.height = 1_100n;
      expect((await dentro.service.sync(d))?.status).toBe('liquidado');
      const abaixo = build({ transfers: [{ txHash: TX1, logIndex: 0, value: 98_000_000n, block: 1_010n }] });
      const b = await create(abaixo.service, 'p1');
      abaixo.chain.height = 1_100n;
      expect((await abaixo.service.sync(b))?.status).toBe('trocado');
    });

    it('transferencia anterior ao pedido nao conta', async () => {
      const { service, chain } = build({ transfers: [{ txHash: TX1, logIndex: 0, value: 99_500_000n, block: 900n }] });
      const a = await create(service, 'p1');
      chain.height = 1_100n;
      expect((await service.sync(a))?.status).toBe('trocado');
    });
  });
});
