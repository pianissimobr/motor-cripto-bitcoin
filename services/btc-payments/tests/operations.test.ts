import { describe, expect, it } from 'vitest';
import type { Repositories } from '../src/db/repositories.js';
import type { CashOutCharge, PixCharge } from '../src/domain/types.js';
import { OperationsService } from '../src/services/operations-service.js';
import { silentLogger } from '../src/logger.js';

const ADDRESS = '0xe49FBc85D36B37Ea85895c339aA9044b0D2B7ce6';

function pixCharge(overrides: Partial<PixCharge> = {}): PixCharge {
  return {
    id: 'pix-1',
    clientId: 'loja-1',
    externalId: 'ext-1',
    provider: 'lunium',
    providerExternalId: 'pix_ext_1',
    providerChargeId: 'ci_1',
    providerStatus: 'paid',
    providerSettlementStatus: 'sent',
    status: 'liquidado',
    settlementStatus: 'pago',
    amountBrlCents: 1000n,
    asset: 'USDC',
    chain: 'polygon',
    destinationAddress: ADDRESS.toLowerCase(),
    assetAmountMinor: 1_558_020n,
    e2e: 'E20855875202611031543SX9I9XU27IJ',
    settlementTxHash: '0xb80bf950',
    settledAt: new Date('2026-11-03T15:47:49Z'),
    createdAt: new Date('2026-11-03T15:37:40Z'),
    updatedAt: new Date('2026-11-03T15:47:49Z'),
    ...overrides,
  } as PixCharge;
}

function cashoutCharge(overrides: Partial<CashOutCharge> = {}): CashOutCharge {
  return {
    id: 'cashout-1',
    clientId: 'usuario-1',
    externalId: 'ext-2',
    provider: 'lunium',
    providerExternalId: 'cashout_ext_1',
    providerCashoutId: 'e2e557cd',
    providerState: 'COMPLETED',
    status: 'pago',
    amountBrlCents: 650n,
    asset: 'USDC',
    network: 'polygon',
    originAddress: ADDRESS.toLowerCase(),
    amountAssetMinor: 1_436_256n,
    txHash: '0xa2a9242d',
    pixE2e: 'E3729393020261104024702902905451d07',
    pixPaidAt: new Date('2026-11-04T02:47:00Z'),
    createdAt: new Date('2026-11-04T02:44:00Z'),
    updatedAt: new Date('2026-11-04T02:47:00Z'),
    ...overrides,
  } as CashOutCharge;
}

type FakeRepos = {
  pix: PixCharge[];
  cashouts: CashOutCharge[];
  clients: Record<string, { clientType: 'loja' | 'usuario'; settlementAddress: string | null }>;
};

function fakeRepos(state: FakeRepos): Repositories {
  return {
    listPixChargesByDestinationAddress: async (address: string, limit: number) =>
      state.pix
        .filter((charge) => charge.destinationAddress === address.toLowerCase())
        .slice(0, limit),
    listCashOutChargesByOriginAddress: async (address: string, limit: number) =>
      state.cashouts
        .filter((charge) => charge.originAddress === address.toLowerCase())
        .slice(0, limit),
    findPixChargeById: async (id: string) => state.pix.find((charge) => charge.id === id) ?? null,
    findCashOutChargeById: async (id: string) =>
      state.cashouts.find((charge) => charge.id === id) ?? null,
    findClientById: async (id: string) => state.clients[id] as never,
  } as unknown as Repositories;
}

function service(state: FakeRepos): OperationsService {
  return new OperationsService({ repos: fakeRepos(state), logger: silentLogger });
}

describe('extrato do perfil pessoal (C5)', () => {
  it('agrega entrada e saida do mesmo endereco', async () => {
    const state: FakeRepos = {
      pix: [pixCharge()],
      cashouts: [cashoutCharge()],
      clients: {
        'loja-1': { clientType: 'loja', settlementAddress: null },
        'usuario-1': { clientType: 'usuario', settlementAddress: ADDRESS },
      },
    };
    const page = await service(state).list({ address: ADDRESS });
    expect(page.items).toHaveLength(2);

    const entrada = page.items.find((item) => item.direction === 'entrada');
    expect(entrada?.kind).toBe('pix_cashin');
    expect(entrada?.origin).toBe('loja');
    expect(entrada?.brl_amount).toBe('10.00');
    expect(entrada?.asset_amount).toBe('1.558020');
    expect(entrada?.e2e).toBe('E20855875202611031543SX9I9XU27IJ');

    const saida = page.items.find((item) => item.direction === 'saida');
    expect(saida?.kind).toBe('pix_cashout');
    expect(saida?.origin).toBe('pessoal');
    expect(saida?.brl_amount).toBe('6.50');
    expect(saida?.asset_amount).toBe('1.436256');
    expect(saida?.tx_hash).toBe('0xa2a9242d');
  });

  it('ordena do mais recente para o mais antigo', async () => {
    const state: FakeRepos = {
      pix: [pixCharge({ id: 'pix-1', createdAt: new Date('2026-11-03T15:37:40Z') })],
      cashouts: [
        cashoutCharge({ id: 'cashout-1', createdAt: new Date('2026-11-04T02:44:00Z') }),
      ],
      clients: {},
    };
    const page = await service(state).list({ address: ADDRESS });
    expect(page.items.map((item) => item.id)).toEqual(['cashout-1', 'pix-1']);
  });

  it('devolve o cursor quando a pagina esta cheia', async () => {
    const state: FakeRepos = {
      pix: [
        pixCharge({ id: 'pix-1' }),
        pixCharge({ id: 'pix-2' }),
      ],
      cashouts: [],
      clients: {},
    };
    const page = await service(state).list({ address: ADDRESS, limit: 2 });
    expect(page.next_cursor).toBeTruthy();
  });

  it('recusa cursor que nao existe', async () => {
    const state: FakeRepos = { pix: [], cashouts: [], clients: {} };
    await expect(
      service(state).list({ address: ADDRESS, cursor: 'nao-existe' }),
    ).rejects.toThrow(/cursor invalido/);
  });
});
