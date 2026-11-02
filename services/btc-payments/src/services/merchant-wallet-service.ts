import { and, eq, isNull } from 'drizzle-orm';
import { parseAccountXpub } from '../adapters/hd/derivation.js';
import type { Db } from '../db/client.js';
import {
  hdAddresses,
  hdWalletState,
  merchantWalletState,
  merchantWallets,
  paymentIntents,
  treasuryWallets,
} from '../db/schema.js';

export type EnsureDefaultWalletInput = {
  xpub?: string;
  xpubFingerprint?: string;
  derivationPrefix: string;
  network: string;
  gapLimit: number;
  coldWalletAddress?: string;
  treasuryBtcAddress?: string;
  treasuryUsdcAddress?: string;
  gasBaseAddress?: string;
};

/**
 * Fase 1: mantem a compatibilidade com o modelo anterior, criando uma
 * carteira BTC default (sem loja) para os enderecos/intents ja existentes.
 * A Fase 2 cria as carteiras por loja.
 */
export async function ensureDefaultWallets(
  db: Db,
  input: EnsureDefaultWalletInput,
): Promise<{ btcDepositWalletId: string | null }> {
  return db.transaction(async (tx) => {
    let walletId: string | null = null;
    if (input.xpub && input.xpubFingerprint) {
      const existingRows = await tx
        .select({ id: merchantWallets.id })
        .from(merchantWallets)
        .where(
          and(
            eq(merchantWallets.kind, 'btc_deposit'),
            isNull(merchantWallets.merchantId),
          ),
        )
        .limit(1);

      walletId = existingRows[0]?.id ?? null;
      if (!walletId) {
        const inserted = await tx
          .insert(merchantWallets)
          .values({
            merchantId: null,
            kind: 'btc_deposit',
            chain: 'bitcoin',
            network: input.network,
            address: 'default',
            xpub: input.xpub,
            derivationPrefix: input.derivationPrefix,
            status: 'ativo',
          })
          .returning({ id: merchantWallets.id });
        walletId = inserted[0]?.id ?? null;
        if (!walletId) throw new Error('falha ao criar carteira BTC default');
      }

      const stateRows = await tx
        .select({ nextReceiveIndex: hdWalletState.nextReceiveIndex })
        .from(hdWalletState)
        .limit(1);
      const nextReceiveIndex = stateRows[0]?.nextReceiveIndex ?? 0;

      await tx
        .insert(merchantWalletState)
        .values({
          walletId,
          nextReceiveIndex,
          gapLimit: input.gapLimit,
          xpubFingerprint: input.xpubFingerprint,
        })
        .onConflictDoNothing({ target: merchantWalletState.walletId });

      await tx
        .update(hdAddresses)
        .set({ merchantWalletId: walletId })
        .where(isNull(hdAddresses.merchantWalletId));

      await tx
        .update(paymentIntents)
        .set({ merchantWalletId: walletId })
        .where(isNull(paymentIntents.merchantWalletId));
    }

    const treasuryRows: Array<{
      kind: 'btc_hot' | 'btc_cold' | 'usdc_hot' | 'gas_base';
      chain: string;
      network: string;
      address: string;
    }> = [];
    if (input.coldWalletAddress) {
      treasuryRows.push({
        kind: 'btc_cold',
        chain: 'bitcoin',
        network: input.network,
        address: input.coldWalletAddress,
      });
    }
    if (
      input.treasuryBtcAddress &&
      input.treasuryBtcAddress !== input.coldWalletAddress
    ) {
      treasuryRows.push({
        kind: 'btc_hot',
        chain: 'bitcoin',
        network: input.network,
        address: input.treasuryBtcAddress,
      });
    }
    if (input.treasuryUsdcAddress) {
      treasuryRows.push({
        kind: 'usdc_hot',
        chain: 'base',
        network: 'base',
        address: input.treasuryUsdcAddress,
      });
    }
    if (input.gasBaseAddress) {
      treasuryRows.push({
        kind: 'gas_base',
        chain: 'base',
        network: 'base',
        address: input.gasBaseAddress,
      });
    }
    if (treasuryRows.length > 0) {
      await tx
        .insert(treasuryWallets)
        .values(treasuryRows.map((row) => ({ ...row, status: 'ativo' as const })))
        .onConflictDoNothing({
          target: [treasuryWallets.chain, treasuryWallets.address],
        });
    }

    return { btcDepositWalletId: walletId };
  });
}

export class MerchantWalletService {
  constructor(private readonly db: Db) {}

  async createBtcDeposit(input: {
    merchantId: string;
    xpub: string;
    derivationPrefix: string;
    network: string;
    gapLimit: number;
  }): Promise<{ id: string; address: string }> {
    return this.db.transaction(async (tx) => {
      const xpub = parseAccountXpub(
        input.xpub,
        input.network as 'bitcoin' | 'testnet' | 'regtest',
      );
      const inserted = await tx
        .insert(merchantWallets)
        .values({
          merchantId: input.merchantId,
          kind: 'btc_deposit',
          chain: 'bitcoin',
          network: input.network,
          address: `xpub:${input.merchantId}`,
          xpub: xpub.normalized,
          derivationPrefix: input.derivationPrefix,
          status: 'ativo',
        })
        .returning({ id: merchantWallets.id, address: merchantWallets.address });
      const wallet = inserted[0];
      if (!wallet) throw new Error('falha ao criar carteira BTC');

      await tx.insert(merchantWalletState).values({
        walletId: wallet.id,
        nextReceiveIndex: 0,
        gapLimit: input.gapLimit,
        xpubFingerprint: xpub.fingerprint,
      });

      return wallet;
    });
  }

  async createUsdcSettlement(input: {
    merchantId: string;
    address: string;
    chain: 'base';
    network: string;
  }): Promise<{ id: string; address: string }> {
    if (!/^0x[a-fA-F0-9]{40}$/.test(input.address)) {
      throw new Error('endereco USDC invalido');
    }
    const inserted = await this.db
      .insert(merchantWallets)
      .values({
        merchantId: input.merchantId,
        kind: 'usdc_settlement',
        chain: input.chain,
        network: input.network,
        address: input.address.toLowerCase(),
        status: 'ativo',
      })
      .returning({ id: merchantWallets.id, address: merchantWallets.address });
    const wallet = inserted[0];
    if (!wallet) throw new Error('falha ao criar carteira USDC');
    return wallet;
  }

  async listByMerchant(merchantId: string) {
    return this.db
      .select()
      .from(merchantWallets)
      .where(eq(merchantWallets.merchantId, merchantId))
      .orderBy(merchantWallets.createdAt);
  }
}
