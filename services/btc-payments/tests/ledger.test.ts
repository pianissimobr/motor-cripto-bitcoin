import { describe, expect, it } from 'vitest';
import {
  accountKindForCode,
  assertBalancedEntries,
  LedgerError,
  merchantAccountCode,
  PLATFORM_ACCOUNTS,
} from '../src/domain/ledger.js';

describe('ledger', () => {
  it('aceita transacao balanceada por ativo', () => {
    expect(() =>
      assertBalancedEntries([
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryBtc,
          asset: 'BTC',
          debitMinor: 100_000n,
        },
        {
          accountCode: merchantAccountCode('m1', 'btc_receivable'),
          merchantId: 'm1',
          asset: 'BTC',
          creditMinor: 100_000n,
        },
      ]),
    ).not.toThrow();
  });

  it('rejeita transacao desbalanceada', () => {
    expect(() =>
      assertBalancedEntries([
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryBtc,
          asset: 'BTC',
          debitMinor: 100_000n,
        },
        {
          accountCode: merchantAccountCode('m1', 'btc_receivable'),
          merchantId: 'm1',
          asset: 'BTC',
          creditMinor: 99_999n,
        },
      ]),
    ).toThrow(LedgerError);
  });

  it('rejeita lancamento com dois lados ou nenhum', () => {
    expect(() =>
      assertBalancedEntries([
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryUsdc,
          asset: 'USDC',
          debitMinor: 1n,
          creditMinor: 1n,
        },
        {
          accountCode: PLATFORM_ACCOUNTS.conversionClearing,
          asset: 'USDC',
          debitMinor: 1n,
          creditMinor: 1n,
        },
      ]),
    ).toThrow(LedgerError);

    expect(() =>
      assertBalancedEntries([
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryUsdc,
          asset: 'USDC',
        },
        {
          accountCode: PLATFORM_ACCOUNTS.conversionClearing,
          asset: 'USDC',
        },
      ]),
    ).toThrow(LedgerError);
  });

  it('exige ao menos dois lancamentos', () => {
    expect(() =>
      assertBalancedEntries([
        {
          accountCode: PLATFORM_ACCOUNTS.treasuryBtc,
          asset: 'BTC',
          debitMinor: 1n,
        },
      ]),
    ).toThrow(LedgerError);
  });

  it('classifica contas por codigo', () => {
    expect(accountKindForCode(PLATFORM_ACCOUNTS.spread)).toBe('revenue');
    expect(accountKindForCode(PLATFORM_ACCOUNTS.networkFees)).toBe('expense');
    expect(accountKindForCode(PLATFORM_ACCOUNTS.treasuryBtc)).toBe('asset');
    expect(accountKindForCode(merchantAccountCode('m1', 'usdc_available'))).toBe(
      'liability',
    );
    expect(accountKindForCode(merchantAccountCode('m1', 'fees'))).toBe('revenue');
  });
});
