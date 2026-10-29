export type ResolvedLightningAmount = {
  sats: bigint;
  /** Unidade em que o LNbits entregou o numero cru. */
  unit: 'sats' | 'msat';
};

function asPositiveInt(value: number | undefined): bigint | null {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return BigInt(value);
}

/**
 * O LNbits ora manda sats, ora msat, no mesmo campo. So aceitamos o numero
 * que bate exatamente com o valor da invoice, numa das duas unidades.
 * Qualquer outro valor (a menos, a mais, ou ambiguo) nao liquida a cobranca.
 */
export function resolvePaidSats(input: {
  invoiceSats: bigint;
  rawAmount?: number;
  dividedSats?: number;
}): ResolvedLightningAmount | null {
  if (input.invoiceSats <= 0n) return null;
  const raw = asPositiveInt(input.rawAmount);
  const divided = asPositiveInt(input.dividedSats);
  if (raw !== null && raw === input.invoiceSats) {
    return { sats: raw, unit: 'sats' };
  }
  if (divided !== null && divided === input.invoiceSats) {
    return { sats: divided, unit: 'msat' };
  }
  return null;
}
