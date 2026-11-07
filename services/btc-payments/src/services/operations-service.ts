import type { Repositories } from '../db/repositories.js';
import { ValidationError } from '../domain/errors.js';
import type { CashOutCharge, PixCharge } from '../domain/types.js';
import type { Logger } from '../logger.js';

export type OperationDirection = 'entrada' | 'saida';
export type OperationKind = 'pix_cashin' | 'pix_cashout';
export type OperationOrigin = 'pessoal' | 'loja';

export type OperationItem = {
  id: string;
  direction: OperationDirection;
  kind: OperationKind;
  /** De onde veio: perfil pessoal ou uma loja. */
  origin: OperationOrigin;
  /** Estado canonico do motor. */
  state: string;
  settlement_status: string | null;
  brl_amount: string;
  asset_amount: string | null;
  asset: 'USDC';
  network: string;
  tx_hash: string | null;
  e2e: string | null;
  receipt_url: string | null;
  verify_url: string | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
  external_id: string;
  /** Recebedor mascarado (cash-out) e endereco de deposito da Lunium. */
  pix_key_masked: string | null;
  deposit_address: string | null;
  provider_state: string | null;
};

export type OperationsPage = {
  items: OperationItem[];
  next_cursor: string | null;
};

export type OperationsServiceDeps = {
  repos: Repositories;
  logger: Logger;
};

const TOKEN_DECIMALS = 6;

function minorToDecimal(value: bigint | null, decimals: number): string | null {
  if (value === null || value === undefined) return null;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  const text =
    decimals > 0
      ? `${whole.toString()}.${fraction.toString().padStart(decimals, '0')}`
      : whole.toString();
  return negative ? `-${text}` : text;
}

function centsToDecimal(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/**
 * Extrato do perfil pessoal (C5).
 *
 * A unidade e a **operacao**, agregar pelo endereco: entradas sao as
 * cobrancas PIX que entregaram USDC no endereco; saidas sao as vendas de USDC
 * que sairam dele. O mesmo endereco em mais de um perfil nao duplica nada —
 * a contagem e da carteira, nao do cadastro.
 */
export class OperationsService {
  constructor(private readonly deps: OperationsServiceDeps) {}

  async list(input: {
    address: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<OperationsPage> {
    const address = input.address.trim().toLowerCase();
    if (!address) throw new ValidationError('endereco obrigatorio');
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    let before: { createdAt: Date; id: string } | null = null;
    if (input.cursor) {
      const pix = await this.deps.repos.findPixChargeById(input.cursor);
      const cashout = pix ? null : await this.deps.repos.findCashOutChargeById(input.cursor);
      const row = pix ?? cashout;
      if (!row) throw new ValidationError('cursor invalido');
      before = { createdAt: row.createdAt, id: row.id };
    }

    const [pixCharges, cashouts] = await Promise.all([
      this.deps.repos.listPixChargesByDestinationAddress(address, limit, before),
      this.deps.repos.listCashOutChargesByOriginAddress(address, limit, before),
    ]);

    const originByClient = await this.resolveOrigins(
      [...pixCharges, ...cashouts],
      address,
    );

    const items = [
      ...pixCharges.map((charge) => this.pixItem(charge, originByClient)),
      ...cashouts.map((charge) => this.cashoutItem(charge, originByClient)),
    ]
      .sort((a, b) => {
        if (a.created_at === b.created_at) return a.id < b.id ? 1 : -1;
        return a.created_at < b.created_at ? 1 : -1;
      })
      .slice(0, limit);

    const last = items[items.length - 1];
    return {
      items,
      next_cursor: items.length === limit && last ? last.id : null,
    };
  }

  /**
   * `pessoal` quando a operacao pertence ao perfil do proprio endereco;
   * `loja` quando veio de um cadastro de loja (a compra do usuario numa
   * loja). Nao diz qual loja: o extrato e da carteira.
   */
  private async resolveOrigins(
    charges: Array<PixCharge | CashOutCharge>,
    address: string,
  ): Promise<Map<string, OperationOrigin>> {
    const result = new Map<string, OperationOrigin>();
    const clientIds = [...new Set(charges.map((charge) => charge.clientId))];
    for (const clientId of clientIds) {
      const client = await this.deps.repos.findClientById(clientId);
      const personal =
        client?.clientType === 'usuario' &&
        (client.settlementAddress ?? '').toLowerCase() === address;
      result.set(clientId, personal ? 'pessoal' : 'loja');
    }
    return result;
  }

  private pixItem(
    charge: PixCharge,
    origins: Map<string, OperationOrigin>,
  ): OperationItem {
    return {
      id: charge.id,
      direction: 'entrada',
      kind: 'pix_cashin',
      origin: origins.get(charge.clientId) ?? 'loja',
      state: charge.status,
      settlement_status: charge.settlementStatus,
      brl_amount: centsToDecimal(charge.amountBrlCents),
      asset_amount: minorToDecimal(charge.assetAmountMinor, TOKEN_DECIMALS),
      asset: 'USDC',
      network: charge.chain,
      tx_hash: charge.settlementTxHash,
      e2e: charge.e2e,
      receipt_url: null,
      verify_url: null,
      created_at: charge.createdAt.toISOString(),
      updated_at: charge.updatedAt.toISOString(),
      settled_at: charge.settledAt?.toISOString() ?? null,
      external_id: charge.externalId,
      pix_key_masked: null,
      deposit_address: null,
      provider_state: charge.providerStatus,
    };
  }

  private cashoutItem(
    charge: CashOutCharge,
    origins: Map<string, OperationOrigin>,
  ): OperationItem {
    return {
      id: charge.id,
      direction: 'saida',
      kind: 'pix_cashout',
      origin: origins.get(charge.clientId) ?? 'pessoal',
      state: charge.status,
      settlement_status: null,
      brl_amount: centsToDecimal(charge.amountBrlCents),
      asset_amount: minorToDecimal(charge.amountAssetMinor, TOKEN_DECIMALS),
      asset: 'USDC',
      network: charge.network,
      tx_hash: charge.txHash,
      e2e: charge.pixE2e,
      receipt_url: charge.receiptUrl,
      verify_url: charge.verifyUrl,
      created_at: charge.createdAt.toISOString(),
      updated_at: charge.updatedAt.toISOString(),
      settled_at: charge.pixPaidAt?.toISOString() ?? null,
      external_id: charge.externalId,
      pix_key_masked: charge.pixKeyMasked,
      deposit_address: charge.depositAddress,
      provider_state: charge.providerState,
    };
  }
}
