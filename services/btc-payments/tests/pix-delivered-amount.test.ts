import { describe, expect, it } from 'vitest';
import { deliveredAmountMinor } from '../src/services/pix-charge-service.js';

/**
 * Regressao da primeira entrega real (2026-11-03): a Lunium nao mandou
 * `asset_amount` no cash-in com `destino: cripto`. O valor entregue veio em
 * `delivery_accounting.aSacar` e o motor ficou em `manual` por nao achar
 * nenhuma quantia.
 */
describe('quantidade entregue no cash-in', () => {
  it('usa o asset_amount quando a Lunium manda', () => {
    expect(
      deliveredAmountMinor({ cashin_id: 'c', status: 'paid', settlement_status: 'sent', amount_cents: 1000, asset_amount: '1.500000' }, null),
    ).toBe(1_500_000n);
  });

  it('usa o aSacar da contabilidade de entrega', () => {
    // Medido: R$ 10,00 -> aSacar 1.55802042 (8 casas), usdtGasto 1.5820698.
    expect(
      deliveredAmountMinor(
        {
          cashin_id: 'c',
          status: 'paid',
          settlement_status: 'sent',
          amount_cents: 1000,
          usdt_amount: '1.5820698',
          delivery_accounting: { asset: 'USDC', aSacar: '1.55802042', usdtGasto: '1.5820698' },
        },
        null,
      ),
    ).toBe(1_558_020n);
  });

  it('trunca nas 6 casas do token, como o Transfer on-chain', () => {
    // O Transfer na rede foi de 1558020 (1.558020 USDC): o minimo da
    // verificacao tem de ser esse, e nao 155802042.
    expect(
      deliveredAmountMinor(
        {
          cashin_id: 'c',
          status: 'paid',
          settlement_status: 'sent',
          amount_cents: 1000,
          delivery_accounting: { aSacar: '1.55802042' },
        },
        null,
      ),
    ).toBe(1_558_020n);
  });

  it('no sandbox usa o campo legado', () => {
    expect(
      deliveredAmountMinor(
        {
          cashin_id: 'c',
          status: 'paid',
          settlement_status: 'sent',
          amount_cents: 2500,
          usdt_amount: '478.42079207',
          sandbox: true,
        },
        null,
      ),
    ).toBe(478_420_792n);
  });

  it('nao usa o usdt_amount em producao (e o comprado, nao o entregue)', () => {
    // Usar 1582069 como minima reprovaria a entrega real de 1558020.
    expect(
      deliveredAmountMinor(
        {
          cashin_id: 'c',
          status: 'paid',
          settlement_status: 'sent',
          amount_cents: 1000,
          usdt_amount: '1.5820698',
        },
        42n,
      ),
    ).toBe(42n);
  });

  it('mantem o valor anterior quando a Lunium nao manda nenhum', () => {
    expect(
      deliveredAmountMinor(
        { cashin_id: 'c', status: 'paid', settlement_status: 'sent', amount_cents: 1000 },
        7n,
      ),
    ).toBe(7n);
  });
});
