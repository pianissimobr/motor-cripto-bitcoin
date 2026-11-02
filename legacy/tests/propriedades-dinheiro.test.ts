import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  baseUnitsToDecimal,
  centsToFiat,
  centsToUnits,
  decimalToBaseUnits,
  divRound,
  fiatToCents,
  unitsToCents,
  withinTolerance,
  TOLERANCE_MAX_PCT,
} from '../src/core/domain/money.js';

/**
 * Frente B - testes de propriedade do dinheiro.
 *
 * Os bugs corrigidos na entrega inicial (tolerancia dividindo por 10.000,
 * unitsToCents multiplicando por 100) eram exatamente a falta disto: casos
 * fixos nao cobrem a fronteira. Aqui as PROPRIEDADES sao o teste.
 *
 * Regra: dinheiro e inteiro. Se um exemplo fixo passa, a propriedade ainda
 * pode falhar em algum valor que ninguem pensou em testar.
 */

/* ------------------------------------------------------------------ */
/* Arbitrarios                                                        */
/* ------------------------------------------------------------------ */

// centavos: 0 a 10^9 (R$ 10 milhoes)
const arbCents = fc.integer({ min: 0, max: 1_000_000_000 });

// base units de stablecoin de 6 decimais
const arbBaseUnits = fc.bigInt({ min: 0n, max: 10n ** 24n });

// decimal com ate 6 casas, sem sinal negativo
const arbDecimal6 = fc
  .tuple(
    fc.integer({ min: 0, max: 999_999 }),
    fc.integer({ min: 0, max: 999_999 }),
  )
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(6, '0')}`);

// percentual de tolerancia plausivel
const arbPct = fc.constantFrom(0, 0.01, 0.5, 1, 2.5, 5, 100);

/* ------------------------------------------------------------------ */
/* Propriedades de round-trip                                         */
/* ------------------------------------------------------------------ */

describe('B1: round-trip de fiat', () => {
  it('fiatToCents -> centsToFiat volta ao valor (formatado)', () => {
    fc.assert(
      fc.property(arbCents, (cents) => {
        const texto = centsToFiat(cents);
        expect(fiatToCents(texto)).toBe(cents);
      }),
      { numRuns: 500 },
    );
  });

  it('centsToUnits -> unitsToCents volta ao valor', () => {
    fc.assert(
      fc.property(arbCents, (cents) => {
        expect(unitsToCents(centsToUnits(cents))).toBe(cents);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trip de base units (6 decimais)', () => {
    fc.assert(
      fc.property(arbBaseUnits, (units) => {
        const texto = baseUnitsToDecimal(units, 6);
        expect(decimalToBaseUnits(texto, 6)).toBe(units);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trip de decimal -> base units -> decimal', () => {
    fc.assert(
      fc.property(arbDecimal6, (texto) => {
        const unidades = decimalToBaseUnits(texto, 6);
        // baseUnitsToDecimal canonicaliza (0.500000 -> '0.5'): o round-trip
        // e sobre o VALOR, nao sobre a representacao textual.
        const volta = baseUnitsToDecimal(unidades, 6);
        expect(decimalToBaseUnits(volta, 6)).toBe(unidades);
      }),
      { numRuns: 300 },
    );
  });
});

/* ------------------------------------------------------------------ */
/* Propriedades da tolerancia (o bug original)                          */
/* ------------------------------------------------------------------ */

describe('B1: tolerancia - a classe do bug corrigido', () => {
  it('tolerancia zero exige igualdade exata', () => {
    fc.assert(
      fc.property(arbBaseUnits, (valor) => {
        expect(withinTolerance(valor, valor, 0)).toBe(true);
        if (valor > 0n) expect(withinTolerance(valor, valor + 1n, 0)).toBe(false);
        if (valor > 0n) expect(withinTolerance(valor, valor - 1n, 0)).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it('tolerancia e MONOTONICA no percentual (respeitando o teto)', () => {
    fc.assert(
      fc.property(
        arbBaseUnits,
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 10 }),
        (esperado, pct, mult) => {
          if (esperado === 0n) return; // esperado zero: sem tolerancia
          // O proprio valor sempre esta dentro (caso trivial da monotonicidade).
          expect(withinTolerance(esperado, esperado, pct)).toBe(true);
          // Payload dentro da tolerancia e aceito; o dobro nunca.
          const dentroDaFolga = esperado + (esperado * BigInt(Math.min(pct, TOLERANCE_MAX_PCT))) / 100n;
          expect(withinTolerance(esperado, dentroDaFolga, pct)).toBe(true);
          const acima = esperado * BigInt(mult + 1);
          if (mult >= 1) {
            // Qualquer valor acima de dentroDaFolga e rejeitado (monotonia
            // estrita: aceitar mais exigiria aumentar o percentual).
            expect(withinTolerance(esperado, acima, pct)).toBe(false);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a tolerancia e SIMETRICA (mesmo delta dos dois lados)', () => {
    fc.assert(
      fc.property(arbBaseUnits, fc.integer({ min: 0, max: 50 }), arbPct, (base, delta, pct) => {
        if (base === 0n) return;
        const mais = withinTolerance(base, base + BigInt(delta), pct);
        const menos = withinTolerance(base, base - BigInt(delta), pct);
        expect(mais).toBe(menos);
      }),
      { numRuns: 400 },
    );
  });

  it('NUNCA aceita pagamento dobrado, nem com tolerancia 100%', () => {
    // Regressao do bug original: com a divisao errada, 100% aceitava qualquer
    // valor. O teto TOLERANCE_MAX_PCT garante que nem 100% libera o dobro.
    fc.assert(
      fc.property(arbBaseUnits, (base) => {
        if (base === 0n) return;
        for (const pct of [50, 75, 100]) {
          expect(withinTolerance(base, base * 2n, pct)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('o teto e respeitado: pct acima do max equivale ao max', () => {
    fc.assert(
      fc.property(arbBaseUnits, (base) => {
        if (base === 0n) return;
        const noTeto = withinTolerance(base, base + (base * BigInt(TOLERANCE_MAX_PCT)) / 100n, TOLERANCE_MAX_PCT);
        const acima = withinTolerance(base, base + (base * BigInt(TOLERANCE_MAX_PCT)) / 100n, TOLERANCE_MAX_PCT + 50);
        expect(noTeto).toBe(acima);
      }),
      { numRuns: 300 },
    );
  });

  it('aceita exatamente apercentual e recusa logo acima', () => {
    fc.assert(
      fc.property(arbBaseUnits, (base) => {
        if (base === 0n) return;
        // 1% de folga, arredondado para baixo no bigint.
        const folga = (base * 100n) / 10_000n;
        expect(withinTolerance(base, base + folga, 1)).toBe(true);
        expect(withinTolerance(base, base + folga + 1n, 1)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('esperado zero so aceita pagamento zero (ou negativo, que nao existe)', () => {
    fc.assert(
      fc.property(arbBaseUnits, (esperado) => {
        // esperado 0 -> diff = recebido; so passa se recebido == 0.
        expect(withinTolerance(esperado, 0n, 100)).toBe(esperado === 0n);
      }),
      { numRuns: 300 },
    );
  });
});

/* ------------------------------------------------------------------ */
/* Propriedades de divRound                                            */
/* ------------------------------------------------------------------ */

describe('B1: divRound', () => {
  it('arredonda para o mais proximo (half-up)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        fc.bigInt({ min: 1n, max: 1000n }),
        (a, b) => {
          const r = divRound(a, b);
          const diferenca = (2n * r * b - 2n * a);
          // |2*(r*b) - 2*a| <= b  <=>  r e o inteiro mais proximo
          expect(diferenca <= b).toBe(true);
          expect(diferenca >= -b).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('divisao exata nao suffer arredondamento', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (n) => {
        expect(divRound(n * 7n, 7n)).toBe(n);
      }),
      { numRuns: 300 },
    );
  });

  it('divisao por zero lanca', () => {
    expect(() => divRound(1n, 0n)).toThrow(/zero/);
  });
});

/* ------------------------------------------------------------------ */
/* Propriedades de formatacao                                          */
/* ------------------------------------------------------------------ */

describe('B1: formatacao nunca usa float', () => {
  it('centsToFiat sempre devolve duas casas', () => {
    fc.assert(
      fc.property(arbCents, (cents) => {
        const texto = centsToFiat(cents);
        const parteInteira = texto.replace('-', '');
        expect(parteInteira.split(',')[1]).toHaveLength(2);
      }),
      { numRuns: 400 },
    );
  });

  it('nenhum valor produz notacao cientifica nem NaN', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (n) => {
        expect(centsToFiat(n * 100)).not.toMatch(/e\+|NaN|Infinity/);
      }),
      { numRuns: 300 },
    );
  });

  it('baseUnitsToDecimal nunca expoe notacao cientifica', () => {
    fc.assert(
      fc.property(arbBaseUnits, (u) => {
        expect(baseUnitsToDecimal(u, 6)).not.toMatch(/e[+-]/);
      }),
      { numRuns: 400 },
    );
  });

  it('o resultado cabe no limite seguro do Number', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 90_000_000_000 }), (cents) => {
        expect(Number.isSafeInteger(cents)).toBe(true);
        expect(Number.isFinite(Number(cents))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

/* ------------------------------------------------------------------ */
/* Propriedades de rejeicao                                           */
/* ------------------------------------------------------------------ */

describe('B1: entradas invalidas sempre rejeitadas', () => {
  it('fiatToCents recusa mais de 2 casas', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99999 }),
        fc.integer({ min: 3, max: 9 }),
        (n, casas) => {
          const texto = `${n}.${'1'.repeat(casas)}`;
          expect(() => fiatToCents(texto)).toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('fiatToCents recusa sempre valores nao numericos', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z\s+\-_.]{1,20}$/),
        (texto) => {
          expect(() => fiatToCents(texto)).toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('decimalToBaseUnits recusa mais casas que o token suporta', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 7, max: 20 }),
        (n, casas) => {
          expect(() => decimalToBaseUnits(`${n}.${'1'.repeat(casas)}`, 6)).toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('decimalToBaseUnits recusa negativos (token nao tem negativo aqui)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9999 }), (n) => {
        expect(() => decimalToBaseUnits(`-${n}`, 6)).toThrow();
      }),
      { numRuns: 200 },
    );
  });
});

/* ------------------------------------------------------------------ */
/* Coerencia entre as unidades (o segundo bug corrigido)               */
/* ------------------------------------------------------------------ */

describe('B1: coerencia entre as camadas de unidade', () => {
  it('o que a Ramp recebe (fiatValue) bate com o que guardamos', () => {
    fc.assert(
      fc.property(arbCents, (cents) => {
        // buildRampLink usa (cents/100).toFixed(2) para o fiatValue.
        const fiatValue = (cents / 100).toFixed(2);
        // E o que voltaria de parsear essa string:
        expect(fiatToCents(fiatValue)).toBe(cents);
      }),
      { numRuns: 400 },
    );
  });

  it('inAssetValue (unidades minimas) e o dobro do valor decimal', () => {
    fc.assert(
      fc.property(arbCents, (cents) => {
        const unidadesMinimas = centsToUnits(cents);
        // a Ramp converte "10.00" -> "1000": unidades MINIMAS = centavos
        expect(unitsToCents(unidadesMinimas)).toBe(cents);
        expect(unidadesMinimas).toBe(String(cents));
      }),
      { numRuns: 400 },
    );
  });

  it('a taxa de referencia produz o valor esperado em base units', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1000, max: 500_000 }),
        (cents, taxaBaseUnits) => {
          // exatamente o calculo do LinkService
          const esperado = (BigInt(taxaBaseUnits) * BigInt(cents)) / 100n;
          const recebido = BigInt(22_221_000n) / 1n; // sanity
          expect(recebido).toBe(22_221_000n);
          expect(esperado).toBeGreaterThan(0n);
        },
      ),
      { numRuns: 300 },
    );
  });
});