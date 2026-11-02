import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { parseAccountXpub } from '../adapters/hd/derivation.js';
import type { Db } from '../db/client.js';
import { merchantWalletState, merchantWallets } from '../db/schema.js';

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
      // Uma carteira BTC ativa por loja: cadastrar outra substitui a anterior.
      await tx
        .update(merchantWallets)
        .set({ status: 'inativo', updatedAt: new Date() })
        .where(
          and(
            eq(merchantWallets.merchantId, input.merchantId),
            eq(merchantWallets.kind, 'btc_deposit'),
            eq(merchantWallets.status, 'ativo'),
          ),
        );
      const inserted = await tx
        .insert(merchantWallets)
        .values({
          merchantId: input.merchantId,
          kind: 'btc_deposit',
          chain: 'bitcoin',
          network: input.network,
          address: `xpub:${input.merchantId}:${randomUUID()}`,
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

  /**
   * Wallet LNbits do lojista. `secretEnc` e a Invoice key ja cifrada; a
   * conexao deve ser conferida antes (o endpoint chama `health`).
   */
  async createLightningLnbits(input: {
    merchantId: string;
    lnbitsUrl: string;
    secretEnc: string;
  }): Promise<{ id: string; address: string }> {
    return this.db.transaction(async (tx) => {
      // Uma wallet Lightning ativa por loja: a nova substitui a anterior. As
      // invoices antigas continuam conferidas na wallet onde foram criadas.
      await tx
        .update(merchantWallets)
        .set({ status: 'inativo', updatedAt: new Date() })
        .where(
          and(
            eq(merchantWallets.merchantId, input.merchantId),
            eq(merchantWallets.kind, 'lightning_lnbits'),
            eq(merchantWallets.status, 'ativo'),
          ),
        );
      const inserted = await tx
        .insert(merchantWallets)
        .values({
          merchantId: input.merchantId,
          kind: 'lightning_lnbits',
          chain: 'lightning',
          network: 'lightning',
          address: `lnbits:${input.merchantId}:${randomUUID()}`,
          lnbitsUrl: input.lnbitsUrl,
          secretEnc: input.secretEnc,
          status: 'ativo',
        })
        .returning({ id: merchantWallets.id, address: merchantWallets.address });
      const wallet = inserted[0];
      if (!wallet) throw new Error('falha ao criar carteira Lightning');
      return wallet;
    });
  }

  async listByMerchant(merchantId: string) {
    return this.db
      .select()
      .from(merchantWallets)
      .where(eq(merchantWallets.merchantId, merchantId))
      .orderBy(merchantWallets.createdAt);
  }
}
