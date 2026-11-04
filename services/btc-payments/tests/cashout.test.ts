import { describe, expect, it } from 'vitest';
import type { LuniumClient } from '../src/adapters/lunium/client.js';
import { testConfig } from './helpers.js';
import { silentLogger } from '../src/logger.js';
import { brCodeCrc16 } from '../src/domain/brcode.js';
import { CashOutService } from '../src/services/cashout-service.js';
import type { Repositories } from '../src/db/repositories.js';
import type { CashOutCharge } from '../src/domain/types.js';

const ORIGIN = '0xe49FBc85D36B37Ea85895c339aA9044b0D2B7ce6';

/** BR Code com CRC16 conferido (o mesmo gerador do app). */
function buildBrCode(fields: { key: string; amount?: string }): string {
  const tag = (id: string, value: string) =>
    `${id}${value.length.toString().padStart(2, '0')}${value}`;
  const payload = [
    '000201',
    tag('00', 'br.gov.bcb.pix'),
    tag('26', fields.key),
    tag('52', '0000'),
    tag('58', 'BR'),
    tag('60', 'SAO PAULO'),
    ...(fields.amount ? [tag('54', fields.amount)] : []),
  ].join('|');
  return `${payload}|${brCodeCrc16(payload)}`;
}

function build(overrides: Record<string, string> = {}) {
  const config = testConfig({
    PIX_ENABLED: 'true',
    CASHOUT_ENABLED: 'true',
    LUNIUM_API_KEY: 'lun_test_key',
    LUNIUM_WEBHOOK_SECRET: 'whk_test',
    ...overrides,
  });
  const repos = {
    findCashOutChargeByClientAndExternalId: async () => null,
    createCashOutCharge: async () => {
      throw new Error('nao usado neste teste');
    },
    updateCashOutCharge: async (input: Record<string, unknown>) =>
      ({
        id: input.id,
        clientId: 'c1',
        externalId: 'e1',
        provider: 'lunium',
        providerExternalId: 'cashout_1',
        amountBrlCents: 650n,
        asset: 'USDC',
        network: 'polygon',
        originAddress: ORIGIN.toLowerCase(),
        depositTag: null,
        feeTotalCents: null,
        pixKeyMasked: null,
        pixKeyType: null,
        brCode: null,
        providerPath: null,
        txHash: null,
        pixE2e: null,
        pixPaidAt: null,
        receiptUrl: null,
        verifyUrl: null,
        refundAddress: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: input.status,
        providerState: input.providerState,
        amountAssetMinor: input.amountAssetMinor,
        providerCashoutId: input.providerCashoutId,
        depositAddress: input.depositAddress,
        providerPayload: input.providerPayload,
        error: input.error,
        attempts: input.attempts,
        version: input.version,
      }) as unknown as CashOutCharge,
    insertWebhookEvent: async () => null,
  } as unknown as Repositories;
  const service = new CashOutService({
    repos,
    lunium: {} as unknown as LuniumClient,
    config,
    logger: silentLogger,
  });
  return { service, config };
}

describe('cash-out (regras)', () => {
  it('exige BR Code ou chave Pix', async () => {
    const { service } = build();
    await expect(
      service.create({
        clientId: 'c1',
        externalId: 'e1',
        amountBrlCents: 650n,
        originAddress: ORIGIN,
      }),
    ).rejects.toThrow(/BR Code do Pix ou a chave Pix/);
  });

  it('com BR Code, o valor vem de dentro do codigo e o pedido precisa bater', async () => {
    const { service } = build();
    const brCode = buildBrCode({ key: 'adm@exemplo.com.br', amount: '6.50' });
    // Valor diferente do que esta no codigo: recusado.
    await expect(
      service.create({
        clientId: 'c1',
        externalId: 'e1',
        amountBrlCents: 700n,
        originAddress: ORIGIN,
        brCode,
      }),
    ).rejects.toThrow(/valor do pedido difere do valor do BR Code/);
  });

  it('recusa um BR Code sem valor quando o pedido tambem nao tem', async () => {
    const { service } = build();
    const brCode = buildBrCode({ key: 'adm@exemplo.com.br' });
    await expect(
      service.create({
        clientId: 'c1',
        externalId: 'e1',
        originAddress: ORIGIN,
        brCode,
      }),
    ).rejects.toThrow(/BR Code sem valor/);
  });

  it('recusa valor abaixo do minimo da Lunium', async () => {
    const { service } = build();
    await expect(
      service.create({
        clientId: 'c1',
        externalId: 'e1',
        amountBrlCents: 100n,
        originAddress: ORIGIN,
        pixKey: 'adm@exemplo.com.br',
      }),
    ).rejects.toThrow(/valor abaixo do minimo/);
  });

  it('recusa valor acima do maximo', async () => {
    const { service } = build();
    await expect(
      service.create({
        clientId: 'c1',
        externalId: 'e1',
        amountBrlCents: 30_000_000n,
        originAddress: ORIGIN,
        pixKey: 'adm@exemplo.com.br',
      }),
    ).rejects.toThrow(/valor acima do maximo/);
  });

  it('recusa um BR Code adulterado (CRC16)', async () => {
    const { service } = build();
    await expect(
      service.create({
        clientId: 'c1',
        externalId: 'e1',
        amountBrlCents: 650n,
        originAddress: ORIGIN,
        brCode: '000201|26|20|adm@exemplo.com.br|54|02|6.50|6304|ABCD',
      }),
    ).rejects.toThrow(/BR Code invalido/);
  });

  it('recusa um tx_hash malformado no deposito', async () => {
    const { service } = build();
    await expect(
      service.reportDeposit('id-1', 'c1', '0x123'),
    ).rejects.toThrow(/tx_hash invalido/);
  });

  it('traduz o estado da Lunium para o canonico', async () => {
    const { service } = build();
    const charge: CashOutCharge = {
      id: 'id-1',
      clientId: 'c1',
      externalId: 'e1',
      provider: 'lunium',
      providerExternalId: 'cashout_1',
      providerCashoutId: 'co_1',
      providerState: 'AWAITING_DEPOSIT',
      status: 'aguardando_deposito',
      amountBrlCents: 650n,
      asset: 'USDC',
      network: 'polygon',
      originAddress: ORIGIN.toLowerCase(),
      depositAddress: null,
      depositTag: null,
      amountAssetMinor: null,
      feeTotalCents: null,
      pixKeyMasked: null,
      pixKeyType: null,
      brCode: null,
      providerPath: null,
      txHash: null,
      pixE2e: null,
      pixPaidAt: null,
      receiptUrl: null,
      verifyUrl: null,
      refundAddress: null,
      providerPayload: null,
      error: null,
      attempts: 0,
      lastCheckedAt: null,
      expiresAt: null,
      metadata: null,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const updated = await service.applyProviderOrder(charge, {
      cashout_id: 'co_1',
      state: 'COMPLETED',
      amount: '1.436256',
      pix_e2e: 'E123',
    });
    expect(updated.status).toBe('liquidado');
    expect(updated.providerState).toBe('COMPLETED');
    expect(updated.amountAssetMinor).toBe(1_436_256n);
  });
});
