import { LnbitsClient } from '../adapters/lnbits/client.js';
import type { AppConfig } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto/cipher.js';
import type { Repositories } from '../db/repositories.js';
import {
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../domain/errors.js';
import type { MerchantWallet } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { MerchantWalletService } from './merchant-wallet-service.js';
import { createSafeFetch } from '../net/safe-fetch.js';
import { assertWebhookUrl, defaultHostLookup } from '../net/webhook-url.js';

/**
 * Lightning direto na carteira do lojista: cada loja cadastra a URL e a
 * Invoice key da wallet LNbits dela. O motor cria a invoice la e confere o
 * pagamento com a mesma chave. O dinheiro nunca passa pela plataforma.
 */
export type MerchantLnbits = Pick<
  LnbitsClient,
  'createInvoice' | 'getPayment' | 'health' | 'isAdminKey'
>;

/** Abre o cliente LNbits de uma carteira `lightning_lnbits` do lojista. */
export type LnbitsFactory = (wallet: MerchantWallet) => MerchantLnbits;

function aadFor(merchantId: string): string {
  return `lnbits-invoice-key:${merchantId}`;
}

export function normalizeLnbitsUrl(raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError('URL do LNbits invalida');
  }
  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) {
    throw new ValidationError('URL do LNbits precisa ser https');
  }
  if (url.username || url.password) {
    throw new ValidationError('URL do LNbits nao pode ter usuario ou senha');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function sealLnbitsKey(config: AppConfig, merchantId: string, invoiceKey: string): string {
  const key = config.crypto.keyring[config.crypto.activeKid];
  if (!key) throw new Error('chave ativa de cifragem ausente');
  return encryptSecret(invoiceKey, key, config.crypto.activeKid, aadFor(merchantId));
}

export function createLnbitsFactory(config: AppConfig, logger: Logger): LnbitsFactory {
  // A URL do LNbits vem do lojista: o servidor nunca pode ser usado para
  // alcancar a rede interna (SSRF), nem depois de uma troca de DNS.
  const fetchImpl = createSafeFetch({ allowLoopback: !config.service.isProduction });
  return (wallet) => {
    if (wallet.kind !== 'lightning_lnbits' || !wallet.lnbitsUrl || !wallet.secretEnc || !wallet.merchantId) {
      throw new Error(`carteira ${wallet.id} nao e uma wallet LNbits valida`);
    }
    return new LnbitsClient({
      url: wallet.lnbitsUrl,
      apiKey: decryptSecret(wallet.secretEnc, config.crypto.keyring, aadFor(wallet.merchantId)),
      timeoutMs: 10_000,
      logger,
      fetchImpl,
    });
  };
}

/**
 * Cadastra a wallet LNbits do lojista: confere a conexao com a Invoice key
 * antes de gravar (cifrada). Usado pela API HMAC e pelo portal.
 */
export async function createLightningWallet(
  services: {
    config: AppConfig;
    repos: Repositories;
    wallets?: MerchantWalletService;
    lnbitsFor?: LnbitsFactory;
  },
  merchantId: string,
  body: { lnbits_url: string; invoice_key: string },
): Promise<MerchantWallet> {
  if (!services.config.lightning.enabled || !services.lnbitsFor || !services.wallets) {
    throw new ServiceUnavailableError('Lightning desabilitado neste motor');
  }
  const lnbitsUrl = normalizeLnbitsUrl(body.lnbits_url, services.config.service.isProduction);
  try {
    await assertWebhookUrl(lnbitsUrl, {
      requireHttps: services.config.service.isProduction,
      lookupHost: defaultHostLookup,
      allowLoopback: !services.config.service.isProduction,
    });
  } catch {
    throw new ValidationError('URL do LNbits invalida ou aponta para a rede interna');
  }
  const secretEnc = sealLnbitsKey(services.config, merchantId, body.invoice_key);
  const now = new Date();
  const probe: MerchantWallet = {
    id: 'probe',
    merchantId,
    kind: 'lightning_lnbits',
    purpose: 'loja',
    chain: 'lightning',
    network: 'lightning',
    address: 'probe',
    xpub: null,
    derivationPrefix: null,
    lnbitsUrl,
    secretEnc,
    status: 'ativo',
    createdAt: now,
    updatedAt: now,
  };
  const client = services.lnbitsFor(probe);
  const health = await client.health();
  if (!health.ok) {
    // Sem detalhe da resposta: o erro nao pode virar sonda da rede alheia.
    throw new ValidationError('nao foi possivel acessar a wallet LNbits com essa URL e Invoice key');
  }
  // A plataforma nunca guarda chave que gaste o saldo do lojista.
  const admin = await client.isAdminKey();
  if (admin === true) {
    throw new ValidationError(
      'essa chave e a Admin key da wallet (ela gasta o saldo). Use a Invoice/read key',
    );
  }
  if (admin === null) {
    throw new ValidationError(
      'nao foi possivel confirmar que a chave e uma Invoice key; confira a URL e a chave',
    );
  }
  const wallet = await services.wallets.createLightningLnbits({
    merchantId,
    lnbitsUrl,
    secretEnc,
  });
  const created = await services.repos.findMerchantWalletById(wallet.id);
  if (!created) throw new NotFoundError('carteira nao encontrada');
  return created;
}
