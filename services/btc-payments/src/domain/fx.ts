import { MAX_SATS } from './money.js';

export class FxError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = 'FxError';
  }
}

const BPS_DENOMINATOR = 10_000n;
const SATS_PER_BTC = 100_000_000n;
const CENTS_PER_UNIT = 100n;

/**
 * Converte um valor em centavos da moeda fiat para sats, usando o preco de
 * 1 BTC na mesma moeda (em centavos) e um spread em basis points.
 *
 * Exemplo: R$ 100,00 (10.000 cents), BTC a R$ 500.000,00 (50.000.000 cents),
 * spread 1% => 20.200 sats.
 */
export function fiatCentsToSats(input: {
  amountFiatCents: bigint;
  btcPriceCents: bigint;
  spreadBps: number;
}): bigint {
  if (input.amountFiatCents <= 0n) {
    throw new FxError('valor fiat precisa ser positivo');
  }
  if (input.btcPriceCents <= 0n) {
    throw new FxError('preco do BTC precisa ser positivo');
  }
  if (!Number.isInteger(input.spreadBps) || input.spreadBps < 0) {
    throw new FxError('spread invalido');
  }
  const numerator =
    input.amountFiatCents * SATS_PER_BTC * (BPS_DENOMINATOR + BigInt(input.spreadBps));
  const denominator = input.btcPriceCents * BPS_DENOMINATOR;
  const sats = numerator / denominator;
  if (sats <= 0n) throw new FxError('valor convertido em sats e zero');
  if (sats > MAX_SATS) throw new FxError('valor convertido acima do limite');
  return sats;
}

/** Retorna sats por unidade inteira da moeda fiat, com 18 casas decimais. */
export function satsPerFiatUnit(input: {
  amountSats: bigint;
  amountFiatCents: bigint;
}): string {
  if (input.amountFiatCents <= 0n) throw new FxError('valor fiat invalido');
  const scale = 10n ** 18n;
  const scaled = (input.amountSats * CENTS_PER_UNIT * scale) / input.amountFiatCents;
  return formatScaled(scaled, 18);
}

export function parseRateToScaled(rate: string, scale = 18): bigint {
  const normalized = rate.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new FxError('taxa invalida');
  const [whole, fraction = ''] = normalized.split('.');
  const padded = fraction.padEnd(scale, '0').slice(0, scale);
  return BigInt(whole!) * 10n ** BigInt(scale) + BigInt(padded || '0');
}

export function formatScaled(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(scale, '0');
  return `${sign}${whole}.${fraction}`;
}


/** Converte um valor fiat expresso em unidade (ex.: "100.00") para centavos. */
export function parseFiatToCents(value: string | number): bigint {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new FxError('valor fiat invalido: use ate 2 casas decimais');
  }
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole!) * CENTS_PER_UNIT + BigInt(fraction.padEnd(2, '0'));
}

/** Converte um decimal de mercado (ex.: "60000.123456") para centavos, truncando. */
export function parseMarketDecimalToCents(value: string): bigint {
  const raw = value.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new FxError('valor de mercado invalido');
  const [whole, fraction = ''] = raw.split('.');
  const cents = fraction.padEnd(2, '0').slice(0, 2);
  return BigInt(whole!) * CENTS_PER_UNIT + BigInt(cents);
}
