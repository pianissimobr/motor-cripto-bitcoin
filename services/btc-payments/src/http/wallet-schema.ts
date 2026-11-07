import { z } from 'zod';

/**
 * Cadastro de carteira da loja.
 *
 * `usdc_settlement` tem dois papeis:
 *
 * - `loja` (padrao): a carteira de liquidacao da **propria loja** — e onde o
 *   PIX que a loja cobra cai. Nao precisa de prova: e o endereco da loja.
 * - `cliente`: o endereco de um **cliente** que a loja cadastrou para
 *   liquidar a compra dele na carteira que o app gerou (F4). Aqui a prova de
 *   posse e obrigatoria: sem ela, qualquer um cadastraria o endereco de outra
 *   pessoa e ficaria com o dinheiro.
 */
export const createWalletSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('btc_deposit'),
      xpub: z.string().min(1),
      derivation_prefix: z
        .string()
        .regex(/^\d+(\/\d+)*$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('usdc_settlement'),
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      purpose: z.enum(['loja', 'cliente']).default('loja'),
      proof: z
        .object({
          nonce: z.string().trim().min(8).max(128),
          signature: z.string().trim().regex(/^0x[a-fA-F0-9]+$/),
        })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.purpose === 'cliente' && !value.proof) {
        ctx.addIssue({
          code: 'custom',
          path: ['proof'],
          message:
            'endereco de cliente exige prova de posse (nonce + assinatura do endereco)',
        });
      }
    }),
  z
    .object({
      kind: z.literal('lightning_lnbits'),
      lnbits_url: z.string().trim().min(1).max(300),
      invoice_key: z.string().trim().min(8).max(200),
    })
    .strict(),
]);
