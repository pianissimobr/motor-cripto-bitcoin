import type { LedgerAccount, LedgerEntryInput } from './types.js';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export const PLATFORM_ACCOUNTS = {
  spread: 'platform:spread',
  networkFees: 'platform:network_fees',
  treasuryBtc: 'treasury:btc',
  treasuryUsdc: 'treasury:usdc',
  conversionClearing: 'conversion:clearing',
} as const;

export function merchantAccountCode(
  merchantId: string,
  suffix: 'btc_receivable' | 'usdc_available' | 'fees' | 'payout_in_transit',
): string {
  return `merchant:${merchantId}:${suffix}`;
}

export function accountKindForCode(code: string): LedgerAccount['kind'] {
  if (code.startsWith('platform:spread')) return 'revenue';
  if (code.startsWith('platform:network_fees')) return 'expense';
  if (code.startsWith('treasury:')) return 'asset';
  if (code.startsWith('conversion:clearing')) return 'asset';
  if (code.startsWith('merchant:')) {
    if (code.endsWith(':fees')) return 'revenue';
    return 'liability';
  }
  return 'asset';
}

function amount(value: bigint | undefined): bigint {
  if (value === undefined) return 0n;
  if (typeof value !== 'bigint') {
    throw new LedgerError('valor do lancamento deve ser bigint');
  }
  if (value < 0n) {
    throw new LedgerError('valor do lancamento nao pode ser negativo');
  }
  return value;
}

export function normalizeEntry(entry: LedgerEntryInput): {
  accountCode: string;
  merchantId: string | null;
  asset: LedgerAccount['asset'];
  debitMinor: bigint;
  creditMinor: bigint;
} {
  if (!entry.accountCode || entry.accountCode.trim().length === 0) {
    throw new LedgerError('accountCode obrigatorio');
  }
  const debitMinor = amount(entry.debitMinor);
  const creditMinor = amount(entry.creditMinor);
  if ((debitMinor > 0n) === (creditMinor > 0n)) {
    throw new LedgerError(
      `lancamento ${entry.accountCode} precisa ter exatamente um lado (debito ou credito)`,
    );
  }
  return {
    accountCode: entry.accountCode,
    merchantId: entry.merchantId ?? null,
    asset: entry.asset,
    debitMinor,
    creditMinor,
  };
}

/**
 * Valida as partidas dobradas por ativo. A soma dos debitos de cada ativo
 * precisa ser exatamente igual a soma dos creditos do mesmo ativo.
 */
export function assertBalancedEntries(entries: LedgerEntryInput[]): void {
  if (entries.length < 2) {
    throw new LedgerError('uma transacao precisa de ao menos dois lancamentos');
  }
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    const current = totals.get(entry.asset) ?? { debit: 0n, credit: 0n };
    current.debit += entry.debitMinor;
    current.credit += entry.creditMinor;
    totals.set(entry.asset, current);
  }
  for (const [asset, total] of totals) {
    if (total.debit !== total.credit) {
      throw new LedgerError(
        `transacao desbalanceada em ${asset}: debito ${total.debit} != credito ${total.credit}`,
      );
    }
    if (total.debit === 0n) {
      throw new LedgerError(`transacao sem valor em ${asset}`);
    }
  }
}
