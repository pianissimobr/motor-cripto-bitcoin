import { createHmac } from 'node:crypto';
import { satsToBtc } from './money.js';

export type Bip21Input = {
  address: string;
  amountSats: bigint;
  label?: string;
  lightning?: string;
};

/**
 * Monta a URI BIP21. Quando a invoice Lightning existe, o mesmo QR Code
 * atende as duas rails (BIP21 + BOLT11 no parametro `lightning`).
 */
export function buildBip21(input: Bip21Input): string {
  const params: string[] = [`amount=${satsToBtc(input.amountSats)}`];
  if (input.label && input.label.trim().length > 0) {
    params.push(`label=${encodeURIComponent(input.label.trim())}`);
  }
  if (input.lightning && input.lightning.trim().length > 0) {
    params.push(`lightning=${encodeURIComponent(input.lightning.trim())}`);
  }
  return `bitcoin:${input.address}?${params.join('&')}`;
}

export function buildLnbitsWebhookUrl(
  publicBaseUrl: string,
  webhookToken: string,
  walletId?: string,
): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const wallet = walletId ? `w=${encodeURIComponent(walletId)}&` : '';
  return `${base}/webhooks/lnbits?${wallet}token=${encodeURIComponent(webhookToken)}`;
}

/**
 * Token do webhook de uma wallet LNbits de lojista. Cada wallet recebe o seu,
 * derivado do LNBITS_WEBHOOK_TOKEN: o segredo do servidor nunca sai dele, e o
 * token que uma loja ve so vale para as invoices da propria wallet.
 */
export function lnbitsWalletWebhookToken(serverToken: string, walletId: string): string {
  return createHmac('sha256', serverToken).update(`lnbits-webhook:${walletId}`).digest('hex');
}
