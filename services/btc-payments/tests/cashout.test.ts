import { describe, expect, it } from 'vitest';
import type { LuniumClient } from '../src/adapters/lunium/client.js';
import { testConfig } from './helpers.js';
import { silentLogger } from '../src/logger.js';
import { brCodeCrc16 } from '../src/domain/brcode.js';
import { CashOutService } from '../src/services/cashout-service.js';
import { DEFAULT_APP_FLAGS, type AppFlags } from '../src/services/flags-service.js';
import type { Repositories } from '../src/db/repositories.js';
import type { CashOutCharge } from '../src/domain/types.js';

const ORIGIN = '0xe49FBc85D36B37Ea85895c339aA9044b0D2B7ce6';

/** BR Code no formato EMV do BACEN (o mesmo do app). */
function buildBrCode(fields: { key: string; amount?: string }): string {
  const tag = (id: string, value: string) =>
    `${id}${String(value.length).padStart(2, '0')}${value}`;
  const accountInfo = tag('00', 'br.gov.bcb.pix') + tag('01', fields.key);
  const parts = [
    '000201',
    tag('26', accountInfo),
    tag('52', '0000'),
    tag('53', '986'),
    fields.amount ? tag('54', fields.amount) : '',
    tag('58', 'BR'),
    tag('59', 'MERCHANT'),
    tag('60', 'SAO PAULO'),
    tag('62', tag('05', '***')),
  ].filter(part => part.length > 0);
  const withoutCrc = parts.join('');
  return `${withoutCrc}6304${brCodeCrc16(`${withoutCrc}6304`)}`;
}

function build(overrides: Record<string, string> = {}, flags?: Partial<AppFlags>) {
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
        gasToppedUpAt: null,
        gasTopUpTxHash: null,
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
    findCashOutChargeByIdForClient: async (id: string) => ({
      id,
      clientId: 'c1',
      status: 'aguardando_deposito',
      providerCashoutId: 'co_1',
      originAddress: ORIGIN.toLowerCase(),
      amountBrlCents: 650n,
    }),
  } as unknown as Repositories;
  const service = new CashOutService({
    repos,
    lunium: {
      previewCashOut: async () => ({ amount: '1.2', brl_amount: '6.50' }),
    } as unknown as LuniumClient,
    config,
    logger: silentLogger,
    ...(flags ? { flags: { get: async () => ({ flags: { ...DEFAULT_APP_FLAGS, ...flags } }) } } : {}),
  });
  return { service, config };
}

describe('cash-out (regras)', () => {
  const dynamicQr = (amount?: string) => {
    const tag = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;
    const body = '000201' + tag('01', '12') +
      tag('26', tag('00', 'br.gov.bcb.pix') + tag('25', 'pix.exemplo.com.br/qr/v2/cobv/9d36b84f')) +
      tag('52', '0000') + tag('53', '986') + (amount ? tag('54', amount) : '') +
      tag('58', 'BR') + tag('59', 'LOJA') + tag('60', 'SAO PAULO') + tag('62', tag('05', '***')) + '6304';
    return body + brCodeCrc16(body);
  };

  it('QR dinamico com valor vai inteiro como BR Code', async () => {
    const { service } = build();
    await expect(service.quote({ brCode: dynamicQr('6.50') })).resolves.toMatchObject({ amount: '1.2' });
  });

  it('QR sem valor no codigo e recusado (dinamico, e estatico mesmo com amount_cents)', async () => {
    const { service } = build();
    await expect(service.quote({ brCode: dynamicQr() })).rejects.toThrow(/QR dinamico sem valor/);
    const staticNoAmount = buildBrCode({ key: 'adm@exemplo.com.br' });
    await expect(service.quote({ brCode: staticNoAmount, amountBrlCents: 650n })).rejects.toThrow(/BR Code sem valor/);
  });

  it('BR Code acima do maximo e recusado (o limite vale sobre o valor do codigo)', async () => {
    const { service } = build();
    const brCode = buildBrCode({ key: 'adm@exemplo.com.br', amount: '300000.00' });
    await expect(
      service.create({ clientId: 'c1', externalId: 'e1', originAddress: ORIGIN, brCode }),
    ).rejects.toThrow(/valor acima do maximo/);
    await expect(service.quote({ brCode })).rejects.toThrow(/valor acima do maximo/);
  });

  it('flag do operador desligada: cotacao, criacao e aceite recusados; deposito segue', async () => {
    const { service } = build({}, { cash_out_enabled: false });
    const brCode = buildBrCode({ key: 'adm@exemplo.com.br', amount: '6.50' });
    await expect(service.quote({ brCode })).rejects.toThrow(/desligado pelo operador/);
    await expect(
      service.create({ clientId: 'c1', externalId: 'e1', originAddress: ORIGIN, brCode }),
    ).rejects.toThrow(/desligado pelo operador/);
    await expect(service.accept('o1', 'c1')).rejects.toThrow(/desligado pelo operador/);
    await expect(service.reportDeposit('o1', 'c1', `0x${'a'.repeat(64)}`)).resolves.toBeTruthy();
  });

  it('o maximo das flags vale quando e mais restrito que o do ambiente', async () => {
    const { service } = build({}, { max_cash_out_brl: 100 });
    const brCode = buildBrCode({ key: 'adm@exemplo.com.br', amount: '150.00' });
    await expect(service.quote({ brCode })).rejects.toThrow(/valor acima do maximo \(10000 centavos\)/);
    const ok = buildBrCode({ key: 'adm@exemplo.com.br', amount: '6.50' });
    await expect(service.quote({ brCode: ok })).resolves.toMatchObject({ amount: '1.2' });
  });

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
        brCode: '000201naoeumbrcode',
      }),
    ).rejects.toThrow(/BR Code/);
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
      gasToppedUpAt: null,
      gasTopUpTxHash: null,
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
