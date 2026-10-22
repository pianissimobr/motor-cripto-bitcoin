import { centsToUnits } from '../domain/money.js';
import type { ParamStyle, RampProfile } from '../domain/types.js';

/**
 * Construtor de URLs de pagamento da Ramp.
 *
 * O projeto usa conta PESSOAL da Ramp (sem `hostApiKey`), entao nao existe
 * webhook: a confirmacao do pagamento vem do monitoramento on-chain. A URL
 * apenas entrega o endereco de deposito derivado e o valor a cobrar.
 *
 * Dois estilos suportados:
 *  - `legacy`  -> https://buy.ramp.network/?userAddress=..&asset=USDC&network=polygon&fiatValue=100&fiatCurrency=BRL
 *  - `unified` -> https://app.rampnetwork.com/?defaultFlow=ONRAMP&inAsset=BRL&inAssetValue=10000&enabledCryptoAssets=POLYGON_USDC&userAddress=..
 *
 * A Ramp converte automaticamente parametros legacy para o formato novo,
 * mas o motor deixa o estilo ser configurado por perfil.
 */

export class RampLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RampLinkError';
  }
}

export type RampLinkInput = {
  profile: Pick<
    RampProfile,
    | 'chain'
    | 'asset'
    | 'fiatCurrency'
    | 'baseUrl'
    | 'paramStyle'
    | 'hostAppName'
    | 'hostLogoUrl'
    | 'hostApiKey'
  > & { rampAssetKey?: string | null };
  depositAddress: string;
  amountCents: number;
  /** id de correlacao (hostPaymentId). A Ramp pode ignorar. */
  paymentId: string;
  /** chave opcional para ofuscar a URL final de retorno. */
  finalUrl?: string | null;
};

export function buildRampLink(input: RampLinkInput): string {
  const { profile, depositAddress, amountCents, paymentId } = input;

  if (!/^0x[a-fA-F0-9]{40}$/.test(depositAddress)) {
    throw new RampLinkError(`endereco de deposito invalido: ${depositAddress}`);
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RampLinkError(`valor de cobranca invalido: ${amountCents}`);
  }
  if (!/^[A-Z]{3}$/.test(profile.fiatCurrency)) {
    throw new RampLinkError(`moeda fiat invalida: ${profile.fiatCurrency}`);
  }

  const url = new URL(profile.baseUrl);
  const style: ParamStyle = profile.paramStyle;

  if (style === 'legacy') {
    url.searchParams.set('userAddress', depositAddress);
    url.searchParams.set('asset', profile.asset);
    url.searchParams.set('network', profile.chain);
    url.searchParams.set('fiatValue', (amountCents / 100).toFixed(2));
    url.searchParams.set('fiatCurrency', profile.fiatCurrency);
    url.searchParams.set('hostPaymentId', paymentId);
    if (profile.hostApiKey) url.searchParams.set('hostApiKey', profile.hostApiKey);
  } else {
    const assetKey = profile.rampAssetKey ?? defaultUnifiedAssetKey(profile.chain, profile.asset);
    url.searchParams.set('defaultFlow', 'ONRAMP');
    url.searchParams.set('enabledCryptoAssets', assetKey);
    url.searchParams.set('userAddress', depositAddress);
    url.searchParams.set('inAsset', profile.fiatCurrency);
    url.searchParams.set('inAssetValue', centsToUnits(amountCents));
    url.searchParams.set('hostPaymentId', paymentId);
    if (profile.hostAppName) url.searchParams.set('hostAppName', profile.hostAppName);
    if (profile.hostLogoUrl) url.searchParams.set('hostLogoUrl', profile.hostLogoUrl);
    if (profile.hostApiKey) url.searchParams.set('hostApiKey', profile.hostApiKey);
    if (input.finalUrl) url.searchParams.set('finalUrl', input.finalUrl);
  }

  return url.toString();
}

function defaultUnifiedAssetKey(chain: string, asset: string): string {
  const prefix = chain.toUpperCase();
  const known: Record<string, string> = {
    POLYGON: 'POLYGON',
    MATIC: 'POLYGON',
    ETHEREUM: 'ETH',
    ETH: 'ETH',
    ARBITRUM: 'ARBITRUM',
    BASE: 'BASE',
    AMOY: 'AMOY',
  };
  return `${known[prefix] ?? prefix}_${asset.toUpperCase()}`;
}
