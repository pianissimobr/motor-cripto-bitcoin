import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { SettlementService } from '../src/core/services/settlement-service.js';
import { setupCore } from './core-fixtures.js';

const NOW = new Date('2026-10-23T15:00:00.000Z');

async function makeLink(context: Awaited<ReturnType<typeof setupCore>>, externalId: string) {
  const { link } = await context.links.create({
    apiClienteId: context.created.client.id,
    externalId,
    amountCents: 10_000,
    rampProfileId: context.profile.id,
    walletId: context.wallet.id,
  });
  return link;
}

async function addPayment(
  context: Awaited<ReturnType<typeof setupCore>>,
  linkId: string,
  valorBaseUnits: bigint,
) {
  await context.repos.payments.upsert({
    linkId,
    txHash: `0x${linkId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`,
    logIndex: 1,
    deAddress: '0x0000000000000000000000000000000000000001',
    paraAddress: '0x0000000000000000000000000000000000000001',
    token: context.profile.tokenContract,
    valorBaseUnits,
    bloco: 1,
    status: 'confirmado',
    detectadoEm: NOW,
  });
}

describe('SettlementService', () => {
  it('expira a pagina e liquida sem pagamento como nao_realizado', async () => {
    const context = await setupCore();
    const link = await makeLink(context, 'settle-1');
    const row = context.repos.links.rows.find((r) => r.id === link.id)!;
    row.expiraEm = new Date(NOW.getTime() - 60_000);
    row.liquidacaoAte = new Date(NOW.getTime() - 1_000);

    const service = new SettlementService({
      repos: context.repos,
      linkState: context.linkState,
      logger: silentLogger,
      tolerancePct: 1,
      now: () => NOW,
    });
    const result = await service.runCycle();
    expect(result).toMatchObject({ paginasExpiradas: 1, liquidados: 0, naoRealizados: 1 });
    const updated = await context.repos.links.findById(link.id);
    expect(updated?.status).toBe('nao_realizado');
    expect(updated?.motivoNaoRealizado).toBe('nao_pago');
  });

  it('liquida valor parcial como nao_realizado', async () => {
    const context = await setupCore();
    const link = await makeLink(context, 'settle-2');
    const row = context.repos.links.rows.find((r) => r.id === link.id)!;
    row.status = 'expirado';
    row.expiraEm = new Date(NOW.getTime() - 120_000);
    row.liquidacaoAte = new Date(NOW.getTime() - 1_000);
    await addPayment(context, link.id, 9_000_000n);

    const service = new SettlementService({
      repos: context.repos,
      linkState: context.linkState,
      logger: silentLogger,
      tolerancePct: 1,
      now: () => NOW,
    });
    const result = await service.runCycle();
    expect(result.naoRealizados).toBe(1);
    const updated = await context.repos.links.findById(link.id);
    expect(updated?.status).toBe('nao_realizado');
    expect(updated?.motivoNaoRealizado).toBe('valor_parcial');
    expect(updated?.valorRecebidoBaseUnits).toBe(9_000_000n);
  });

  it('liquida valor cheio como pago', async () => {
    const context = await setupCore();
    const link = await makeLink(context, 'settle-3');
    const row = context.repos.links.rows.find((r) => r.id === link.id)!;
    row.status = 'expirado';
    row.expiraEm = new Date(NOW.getTime() - 120_000);
    row.liquidacaoAte = new Date(NOW.getTime() - 1_000);
    await addPayment(context, link.id, 18_000_000n);

    const service = new SettlementService({
      repos: context.repos,
      linkState: context.linkState,
      logger: silentLogger,
      tolerancePct: 1,
      now: () => NOW,
    });
    const result = await service.runCycle();
    expect(result.liquidados).toBe(1);
    const updated = await context.repos.links.findById(link.id);
    expect(updated?.status).toBe('pago');
    expect(updated?.valorRecebidoBaseUnits).toBe(18_000_000n);
  });
});
