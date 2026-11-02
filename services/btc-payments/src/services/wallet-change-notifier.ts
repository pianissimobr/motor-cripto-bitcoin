import { randomUUID } from 'node:crypto';
import type { Repositories } from '../db/repositories.js';
import type { MerchantWallet } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { AlertService } from './alert-service.js';
import type { EmailSender } from './email-sender.js';

export type WalletChangeAction = 'cadastrada' | 'removida';

const KIND_LABEL: Record<string, string> = {
  lightning_lnbits: 'Lightning (LNbits)',
  btc_deposit: 'BTC on-chain (xpub)',
  usdc_settlement: 'USDC na Base (PIX)',
};

/** Destino legivel e sem segredo: URL do LNbits, inicio/fim do xpub ou o 0x. */
function destinationOf(wallet: MerchantWallet): string {
  if (wallet.kind === 'lightning_lnbits') return wallet.lnbitsUrl ?? 'LNbits';
  if (wallet.kind === 'btc_deposit' && wallet.xpub) {
    return `${wallet.xpub.slice(0, 8)}...${wallet.xpub.slice(-6)}`;
  }
  return wallet.address;
}

/**
 * Trocar a carteira de recebimento desvia os proximos pagamentos. Toda troca
 * avisa a loja (webhook `merchant.wallet_changed`), os membros por e-mail, o
 * operador (alerta) e fica na auditoria. Assim uma troca indevida aparece.
 */
export class WalletChangeNotifier {
  constructor(
    private readonly deps: {
      repos: Repositories;
      logger: Logger;
      alerts?: AlertService;
      emailSender?: EmailSender;
      now?: () => Date;
    },
  ) {}

  async notify(input: {
    merchantId: string;
    wallet: MerchantWallet;
    action: WalletChangeAction;
    actor: string;
  }): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    const kind = KIND_LABEL[input.wallet.kind] ?? input.wallet.kind;
    const destination = destinationOf(input.wallet);

    await this.deps.repos.insertAuditEvent({
      actor: input.actor,
      action: `merchant.wallet_${input.action === 'cadastrada' ? 'added' : 'removed'}`,
      entity: 'merchant_wallet',
      entityId: input.wallet.id,
      metadata: { merchantId: input.merchantId, kind: input.wallet.kind, destination },
    });

    await this.deps.repos.insertWebhookEvent({
      clientId: input.merchantId,
      eventType: 'merchant.wallet_changed',
      dedupeKey: `wallet:${input.wallet.id}:${input.action}`,
      payload: {
        event: 'merchant.wallet_changed',
        event_id: randomUUID(),
        created_at: now.toISOString(),
        data: {
          merchant_id: input.merchantId,
          wallet_id: input.wallet.id,
          kind: input.wallet.kind,
          action: input.action,
          destination,
          actor: input.actor,
        },
      },
    });

    await this.deps.alerts?.send({
      level: 'warn',
      title: 'carteira de recebimento alterada',
      message: `${kind} ${input.action}`,
      metadata: { merchantId: input.merchantId, walletId: input.wallet.id, actor: input.actor },
    });

    if (this.deps.emailSender) {
      const emails = await this.deps.repos.listMerchantMemberEmails(input.merchantId);
      for (const to of emails) {
        await this.deps.emailSender
          .sendSecurityNotice({
            to,
            subject: `Carteira ${kind} ${input.action} na sua loja`,
            text:
              `A carteira ${kind} da sua loja foi ${input.action} (${destination}) em ` +
              `${now.toISOString()}. Os proximos pagamentos desse trilho vao para ela. ` +
              'Se nao foi voce, troque a senha e revise as carteiras no portal agora.',
          })
          .catch((err: unknown) => {
            this.deps.logger.error({ err, merchantId: input.merchantId }, 'falha ao enviar aviso de carteira');
          });
      }
    }
  }
}
