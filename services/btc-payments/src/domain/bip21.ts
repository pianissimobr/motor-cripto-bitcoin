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
): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return `${base}/webhooks/lnbits?token=${encodeURIComponent(webhookToken)}`;
}
