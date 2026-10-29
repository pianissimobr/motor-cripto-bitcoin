export const SATS_PER_BTC = 100_000_000n;
export const MAX_SATS = 21_000_000n * SATS_PER_BTC;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Converte sats para a representacao decimal exata usada no BIP21. */
export function satsToBtc(sats: bigint): string {
  if (sats < 0n) throw new MoneyError('sats nao pode ser negativo');
  const whole = sats / SATS_PER_BTC;
  const fraction = (sats % SATS_PER_BTC).toString().padStart(8, '0');
  return `${whole}.${fraction}`;
}

/** Converte a string decimal de BTC (8 casas) para sats, sem float. */
export function btcToSats(btc: string): bigint {
  const normalized = btc.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(normalized)) {
    throw new MoneyError('BTC invalido: use ate 8 casas decimais, sem sinal');
  }
  const [whole, fraction = ''] = normalized.split('.');
  const padded = fraction.padEnd(8, '0');
  return BigInt(whole!) * SATS_PER_BTC + BigInt(padded);
}

/** Aceita string, number inteiro ou bigint. Rejeita float e sinal. */
export function parseSats(value: string | number | bigint): bigint {
  let sats: bigint;
  if (typeof value === 'bigint') sats = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError('sats deve ser um inteiro seguro');
    }
    sats = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new MoneyError('sats deve ser um inteiro nao-negativo em string');
    }
    sats = BigInt(trimmed);
  }
  if (sats < 0n) throw new MoneyError('sats nao pode ser negativo');
  if (sats > MAX_SATS) throw new MoneyError('sats acima do limite de 21 milhoes de BTC');
  return sats;
}

export function satsToString(sats: bigint): string {
  return sats.toString();
}
