import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema.js';
import {
  accountKindForCode,
  assertBalancedEntries,
  LedgerError,
  normalizeEntry,
} from '../domain/ledger.js';
import type { LedgerAccount, LedgerEntryInput } from '../domain/types.js';

export type PostLedgerTransactionInput = {
  kind: string;
  referenceType: string;
  referenceId: string;
  entries: LedgerEntryInput[];
};

export type MerchantBalance = {
  accountCode: string;
  asset: LedgerAccount['asset'];
  kind: LedgerAccount['kind'];
  debit: bigint;
  credit: bigint;
  balance: bigint;
};

export type AssetTotals = {
  asset: string;
  debit: bigint;
  credit: bigint;
  balanced: boolean;
};

export type AccountTotals = {
  accountId: string;
  code: string;
  asset: string;
  debit: bigint;
  credit: bigint;
  balance: bigint;
};

/**
 * Livro de partidas dobradas. Cada transacao e atomica e immutable; saldos
 * sao derivados dos lancamentos, nunca atualizados diretamente.
 */
export class LedgerService {
  constructor(private readonly db: Db) {}

  async postTransaction(
    input: PostLedgerTransactionInput,
  ): Promise<{ id: string }> {
    assertBalancedEntries(input.entries);
    const normalized = input.entries.map(normalizeEntry);

    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(
          and(
            eq(ledgerTransactions.kind, input.kind),
            eq(ledgerTransactions.referenceType, input.referenceType),
            eq(ledgerTransactions.referenceId, input.referenceId),
          ),
        )
        .limit(1);
      if (existing[0]) return existing[0];

      const transactionRows = await tx
        .insert(ledgerTransactions)
        .values({
          kind: input.kind,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
        })
        .onConflictDoNothing({
          target: [
            ledgerTransactions.kind,
            ledgerTransactions.referenceType,
            ledgerTransactions.referenceId,
          ],
        })
        .returning({ id: ledgerTransactions.id });
      const transaction = transactionRows[0];
      if (!transaction) {
        const raced = await tx
          .select({ id: ledgerTransactions.id })
          .from(ledgerTransactions)
          .where(
            and(
              eq(ledgerTransactions.kind, input.kind),
              eq(ledgerTransactions.referenceType, input.referenceType),
              eq(ledgerTransactions.referenceId, input.referenceId),
            ),
          )
          .limit(1);
        if (raced[0]) return raced[0];
        throw new LedgerError('falha ao criar transacao');
      }

      const accounts = new Map<string, LedgerAccount>();
      for (const entry of normalized) {
        const key = `${entry.accountCode}:${entry.asset}`;
        let account = accounts.get(key);
        if (!account) {
          await tx
            .insert(ledgerAccounts)
            .values({
              merchantId: entry.merchantId,
              code: entry.accountCode,
              asset: entry.asset,
              kind: accountKindForCode(entry.accountCode),
            })
            .onConflictDoNothing({
              target: [ledgerAccounts.code, ledgerAccounts.asset],
            });
          const rows = await tx
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.code, entry.accountCode),
                eq(ledgerAccounts.asset, entry.asset),
              ),
            )
            .limit(1);
          account = rows[0];
          if (!account) throw new LedgerError('falha ao criar conta do ledger');
          accounts.set(key, account);
        }

        await tx.insert(ledgerEntries).values({
          transactionId: transaction.id,
          accountId: account.id,
          asset: entry.asset,
          debitMinor: entry.debitMinor,
          creditMinor: entry.creditMinor,
        });
      }

      return transaction;
    });
  }

  async getMerchantBalances(merchantId: string): Promise<MerchantBalance[]> {
    const rows = await this.db
      .select({
        accountCode: ledgerAccounts.code,
        asset: ledgerAccounts.asset,
        kind: ledgerAccounts.kind,
        debit: sql<string>`coalesce(sum(${ledgerEntries.debitMinor}), 0)::text`,
        credit: sql<string>`coalesce(sum(${ledgerEntries.creditMinor}), 0)::text`,
      })
      .from(ledgerAccounts)
      .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .where(eq(ledgerAccounts.merchantId, merchantId))
      .groupBy(
        ledgerAccounts.id,
        ledgerAccounts.code,
        ledgerAccounts.asset,
        ledgerAccounts.kind,
      )
      .orderBy(ledgerAccounts.code);

    return rows.map((row) => {
      const debit = BigInt(row.debit);
      const credit = BigInt(row.credit);
      return {
        accountCode: row.accountCode,
        asset: row.asset,
        kind: row.kind,
        debit,
        credit,
        balance: row.kind === 'liability' ? credit - debit : debit - credit,
      };
    });
  }

  async getAssetTotals(): Promise<AssetTotals[]> {
    const rows = await this.db
      .select({
        asset: ledgerEntries.asset,
        debit: sql<string>`coalesce(sum(${ledgerEntries.debitMinor}), 0)::text`,
        credit: sql<string>`coalesce(sum(${ledgerEntries.creditMinor}), 0)::text`,
      })
      .from(ledgerEntries)
      .groupBy(ledgerEntries.asset)
      .orderBy(ledgerEntries.asset);
    return rows.map((row) => {
      const debit = BigInt(row.debit);
      const credit = BigInt(row.credit);
      return {
        asset: row.asset,
        debit,
        credit,
        balanced: debit === credit,
      };
    });
  }

  async getAccountTotals(
    accountCode: string,
    asset: LedgerAccount['asset'],
  ): Promise<AccountTotals> {
    const rows = await this.db
      .select({
        accountId: ledgerAccounts.id,
        code: ledgerAccounts.code,
        asset: ledgerAccounts.asset,
        debit: sql<string>`coalesce(sum(${ledgerEntries.debitMinor}), 0)::text`,
        credit: sql<string>`coalesce(sum(${ledgerEntries.creditMinor}), 0)::text`,
      })
      .from(ledgerAccounts)
      .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .where(and(eq(ledgerAccounts.code, accountCode), eq(ledgerAccounts.asset, asset)))
      .groupBy(ledgerAccounts.id, ledgerAccounts.code, ledgerAccounts.asset);

    const row = rows[0];
    if (!row) {
      return { accountId: '', code: accountCode, asset, debit: 0n, credit: 0n, balance: 0n };
    }
    const debit = BigInt(row.debit);
    const credit = BigInt(row.credit);
    return {
      accountId: row.accountId,
      code: row.code,
      asset: row.asset,
      debit,
      credit,
      balance: debit - credit,
    };
  }
}
