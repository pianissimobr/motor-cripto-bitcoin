/**
 * Aritmetica de dinheiro em inteiros. Sem float, sem `toFixed`, sem `parseFloat`
 * em valores que viram saldo.
 */

/**
 * Converte "123,45" | "123.45" (BRL ou USD) em centavos.
 *
 * A conversao e feita em inteiros: nada de `Number(x) * 100`, que pode
 * arredondar 0,29 para 28 centavos por erro de ponto flutuante.
 */
export function fiatToCents(input: string | number): number {
  let raw: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error(`valor invalido: "${String(input)}" (use ate 2 casas decimais)`);
    }
    raw = String(input);
  } else {
    raw = input.trim();
  }

  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(raw);
  if (!match) {
    throw new Error(`valor invalido: "${String(input)}" (use ate 2 casas decimais)`);
  }
  const whole = BigInt(match[1]!);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = whole * 100n + BigInt(fraction || '0');
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('valor fora do intervalo seguro');
  }
  return Number(cents);
}

/** Converte centavos para string no formato brasileiro: 12345 -> "123,45". */
export function centsToFiat(cents: number | bigint): string {
  const value = typeof cents === 'bigint' ? cents : BigInt(cents);
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole},${fraction}`;
}

/**
 * Centavos -> unidades ISO-4217 em unidades minimas ("minor units").
 *
 * ATENCAO: a Ramp usa "unidades" no mesmo sentido de unidades minimas:
 * "10.00" EUR -> "1000". Logo 15.000 centavos (R$ 150,00) = "15000".
 */
export function centsToUnits(cents: number): string {
  return String(cents);
}

/** Unidades ISO-4217 (minimas) -> centavos. "10000" -> 10000 centavos. */
export function unitsToCents(units: string): number {
  if (!/^\d+$/.test(units)) throw new Error(`unidades invalidas: "${units}"`);
  const cents = Number(units);
  if (!Number.isSafeInteger(cents)) throw new Error('valor fora do intervalo seguro');
  return cents;
}

/** Base units -> string decimal, sem float. 1000000n (6 decimais) -> "1". */
export function baseUnitsToDecimal(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fractionStr ? `.${fractionStr}` : ''}`;
}

/** String decimal -> base units, sem float. "1.5" (6 decimais) -> 1500000n. */
export function decimalToBaseUnits(input: string, decimals: number): bigint {
  const normalized = input.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`valor decimal invalido: "${input}"`);
  }
  const [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) {
    throw new Error(`valor com mais de ${decimals} casas decimais: "${input}"`);
  }
  const padded = fraction.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

/** Divisao inteira com arredondamento (half-up), sem float. */
export function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('divisao por zero');
  const negative = (a < 0n) !== (b < 0n);
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const result = (absA * 2n + absB) / (absB * 2n);
  return negative ? -result : result;
}

/**
 * Teto da tolerancia, em percentual.
 *
 * A propriedade de teste encontrou o problema: com `tolerancePct=100`, a
 * formula pura aceitaria um pagamento ate 2x o esperado - o dobro do valor.
 * Isso e matematicamente correto, mas e um erro de negocio: nenhum motor de
 * pagamento deve aceitar o dobro como "dentro da tolerancia".
 *
 * O teto de 50% ainda absorve variacao cambial grande e pagamento parcial
 * proposital, sem nunca liberar o dobro. Configuracoes acima disso sao
 * cortadas de proposito.
 */
export const TOLERANCE_MAX_PCT = 50;

/**
 * Percentual de tolerancia aplicado em base units.
 *
 * `tolerancePct` e um percentual (1 = 1%), limitado a TOLERANCE_MAX_PCT.
 * A aritmetica e feita em bigint com 4 casas de precisao no percentual
 * para nao perder divisao inteira (e nunca passa por float).
 */
export function withinTolerance(
  expected: bigint,
  received: bigint,
  tolerancePct: number,
): boolean {
  if (expected <= 0n) return received >= 0n;
  const diff = received >= expected ? received - expected : expected - received;

  const pct = Math.min(Math.max(tolerancePct, 0), TOLERANCE_MAX_PCT);
  const scaled = BigInt(Math.round(pct * 10_000));
  const limit = (expected * scaled) / 1_000_000n;
  return diff <= limit;
}
