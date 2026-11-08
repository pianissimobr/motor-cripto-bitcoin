import { describe, expect, it } from 'vitest';
import { PaymentRequestService, deriveRequestStatus } from '../src/services/payment-request-service.js';
import { silentLogger } from '../src/logger.js';
import { testConfig } from './helpers.js';
import type { Repositories } from '../src/db/repositories.js';
import type { PaymentRequest } from '../src/db/repositories.js';

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';

type Harness = {
  service: PaymentRequestService;
  rows: PaymentRequest[];
  pixCharges: { created: number };
  swap: { created: number };
};

function build(options: { pixKey?: { pixKey: string } | null } = {}): Harness {
  const rows: PaymentRequest[] = [];
  const pixCharges = { created: 0 };
  const swap = { created: 0 };
  let stored: PaymentRequest | null = null;

  const now = new Date('2026-11-07T00:00:00.000Z');
  const repos = {
    findPaymentRequestByClientAndExternalId: async () => stored,
    createPaymentRequest: async (input: Record<string, unknown>) => {
      const created: PaymentRequest = {
        id: String(input.id),
        clientId: CLIENT_ID,
        externalId: String(input.externalId),
        amountFiatCents: input.amountFiatCents as bigint,
        currency: input.currency as 'BRL',
        rails: input.rails as string[],
        status: 'criando',
        pixChargeId: null,
        swapOrderId: null,
        pixDirect: null,
        expiresAt: null,
        metadata: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(created);
      stored = created;
      return created;
    },
    updatePaymentRequest: async (input: Record<string, unknown>) => {
      const current = rows.find((row) => row.id === input.id);
      if (!current) return null;
      const updated = { ...current, ...input } as PaymentRequest;
      rows[rows.indexOf(current)] = updated;
      stored = updated;
      return updated;
    },
    findPaymentRequestById: async (id: string) => rows.find((row) => row.id === id) ?? null,
    findClientPixKeyByClientId: async () =>
      options.pixKey
        ? {
            id: 'pk_1',
            clientId: CLIENT_ID,
            address: '0x1111111111111111111111111111111111111111',
            pixKey: options.pixKey.pixKey,
            pixKeyType: 'cpf' as const,
            merchantName: 'PIANO LAB',
            city: 'RIBEIRAO PRETO',
            status: 'ativo' as const,
            createdAt: now,
            updatedAt: now,
          }
        : null,
  } as unknown as Repositories;

  const pixChargeService = {
    create: async () => {
      pixCharges.created += 1;
      return {
        dto: {
          id: 'pc_1',
          external_id: 'x',
          provider: 'lunium',
          provider_charge_id: null,
          status: 'pendente',
          settlement_status: 'pending',
          amount_brl_cents: '10000',
          asset: 'usdc',
          chain: 'polygon',
          pix: { qr_copypaste: '000201-pix', qr_image_url: null, qr_svg: null, expires_at: null },
          payout_id: null,
          error: null,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        reused: false,
      };
    },
    getById: async () => ({
      id: 'pc_1',
      external_id: 'x',
      provider: 'lunium',
      provider_charge_id: null,
      status: 'pendente',
      settlement_status: 'pending',
      amount_brl_cents: '10000',
      asset: 'usdc',
      chain: 'polygon',
      pix: { qr_copypaste: '000201-pix', qr_image_url: null, qr_svg: null, expires_at: null },
      payout_id: null,
      error: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }),
  };

  const swapService = {
    create: async () => {
      swap.created += 1;
      return {
        dto: {
          id: 'swap_1',
          external_id: 'x',
          provider: 'swapkit',
          status: 'aguardando_deposito',
          provider_state: null,
          amount_fiat_cents: '10000',
          currency: 'BRL',
          amount_sats: '200000',
          asset: 'USDC',
          network: 'polygon',
          destination_address: '0x1111111111111111111111111111111111111111',
          bitcoin: {
            address: 'bc1qexemplo',
            amount_btc: '0.002',
            bip21: 'bitcoin:bc1qexemplo?amount=0.002',
            qr_svg: '<svg/>',
            expires_at: null,
          },
          error: null,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        reused: false,
      };
    },
    get: async () => ({
      id: 'swap_1',
      external_id: 'x',
      provider: 'swapkit',
      status: 'aguardando_deposito',
      provider_state: null,
      amount_fiat_cents: '10000',
      currency: 'BRL',
      amount_sats: '200000',
      asset: 'USDC',
      network: 'polygon',
      destination_address: '0x1111111111111111111111111111111111111111',
      bitcoin: {
        address: 'bc1qexemplo',
        amount_btc: '0.002',
        bip21: 'bitcoin:bc1qexemplo?amount=0.002',
        qr_svg: '<svg/>',
        expires_at: null,
      },
      error: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }),
  };

  const service = new PaymentRequestService({
    repos,
    config: testConfig({ PIX_ENABLED: 'true', LUNIUM_API_KEY: 'lun_test_key', LUNIUM_WEBHOOK_SECRET: 'whk_test_123' }),
    logger: silentLogger,
    pixCharges: pixChargeService as never,
    swap: swapService as never,
  });

  return { service, rows, pixCharges, swap };
}

describe('PaymentRequestService', () => {
  it('devolve as opcoes de um pedido (Pix e Bitcoin)', async () => {
    const { service, pixCharges, swap } = build();
    const { dto } = await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
      payerTaxNumber: '00000000191',
    });

    expect(pixCharges.created).toBe(1);
    expect(swap.created).toBe(1);
    expect(dto.options.pix?.qr_copypaste).toBe('000201-pix');
    expect(dto.options.bitcoin?.bip21).toContain('bitcoin:bc1qexemplo');
    expect(dto.options.pix_direto).toBeNull();
    expect(dto.amount_cents).toBe('10000');
  });

  it('exige o CPF do pagador no trilho Pix', async () => {
    const { service } = build();
    await expect(
      service.create({
        clientId: CLIENT_ID,
        externalId: 'pedido_1',
        amountFiatCents: 10_000n,
        currency: 'BRL',
        rails: ['pix'],
      }),
    ).rejects.toThrow(/CPF/);
  });

  it('inclui o Pix direto quando o usuario tem chave Pix', async () => {
    const { service } = build({ pixKey: { pixKey: '12345678909' } });
    const { dto } = await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
      payerTaxNumber: '00000000191',
    });

    expect(dto.options.pix_direto?.br_code).toContain('000201');
    expect(dto.options.pix_direto?.amount).toBe('100.00');
    // A chave sai mascarada: e dado pessoal do usuario.
    expect(dto.options.pix_direto?.key_masked).not.toBe('12345678909');
  });

  it('o mesmo external_id nao abre um segundo pedido', async () => {
    const { service, pixCharges, swap } = build();
    await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
      payerTaxNumber: '00000000191',
    });
    const second = await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
      payerTaxNumber: '00000000191',
    });

    expect(second.reused).toBe(true);
    expect(pixCharges.created).toBe(1);
    expect(swap.created).toBe(1);
  });

  it('mostra o estado de cada trilho e marca o Pix direto como nao observado', async () => {
    const { service } = build({ pixKey: { pixKey: '12345678909' } });
    const { dto } = await service.create({
      clientId: CLIENT_ID,
      externalId: 'pedido_1',
      amountFiatCents: 10_000n,
      currency: 'BRL',
      payerTaxNumber: '00000000191',
    });
    const fetched = await service.get(dto.id);
    expect(fetched?.options.pix?.status).toBe('pendente');
    expect(fetched?.options.bitcoin?.status).toBe('aguardando_deposito');
    expect(fetched?.options.pix_direto?.status).toBe('nao_observado');
    expect(fetched?.status).toBe('pendente');
    expect(fetched?.paid_rail).toBeNull();
  });
});

describe('estado do pedido a partir dos trilhos', () => {
  const base = { stored: 'pendente' as const, pix: null, bitcoin: null, hasPixDirect: false };

  it('Pix pago ou swap liquidado deixam o pedido pago', () => {
    expect(deriveRequestStatus({ ...base, pix: 'pago', bitcoin: 'aguardando_deposito' })).toEqual({
      status: 'pago',
      paidRail: 'pix',
    });
    expect(deriveRequestStatus({ ...base, pix: 'expirado', bitcoin: 'liquidado' })).toEqual({
      status: 'pago',
      paidRail: 'bitcoin',
    });
  });

  it('swap so depositado ainda nao e pago', () => {
    expect(deriveRequestStatus({ ...base, bitcoin: 'depositado' }).status).toBe('pendente');
  });

  it('todos os trilhos mortos: expirado', () => {
    expect(deriveRequestStatus({ ...base, pix: 'expirado', bitcoin: 'falhou' }).status).toBe('expirado');
  });

  it('com Pix direto nunca declara expirado: o pagamento pode ter ido para a chave', () => {
    expect(
      deriveRequestStatus({ ...base, pix: 'expirado', bitcoin: 'expirado', hasPixDirect: true }).status,
    ).toBe('pendente');
    expect(deriveRequestStatus({ ...base, hasPixDirect: true }).status).toBe('pendente');
  });

  it('estado gravado diferente de pendente passa como esta', () => {
    expect(deriveRequestStatus({ ...base, stored: 'cancelado', pix: 'pago' }).status).toBe('cancelado');
  });
});
