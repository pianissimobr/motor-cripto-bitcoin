-- Canonicalizacao de enderecos EVM: armazenar SEMPRE lowercase.
-- A comparacao text do Postgres e case-sensitive; o checksum EIP-55 era
-- gravado e a busca por `lower(param)` nunca encontrava o link.
UPDATE "carteiras_frias" SET "address" = lower("address") WHERE "address" <> lower("address");
--> statement-breakpoint
UPDATE "links_gerados"
SET
  "endereco_deposito" = lower("endereco_deposito"),
  "token_contract" = lower("token_contract"),
  "carteira_fria_endereco" = lower("carteira_fria_endereco")
WHERE
  "endereco_deposito" <> lower("endereco_deposito")
  OR "token_contract" <> lower("token_contract")
  OR ("carteira_fria_endereco" IS NOT NULL AND "carteira_fria_endereco" <> lower("carteira_fria_endereco"));
--> statement-breakpoint
UPDATE "links_pagos"
SET
  "tx_hash" = lower("tx_hash"),
  "de_address" = lower("de_address"),
  "para_address" = lower("para_address"),
  "token" = lower("token")
WHERE
  "tx_hash" <> lower("tx_hash")
  OR "de_address" <> lower("de_address")
  OR "para_address" <> lower("para_address")
  OR "token" <> lower("token");
--> statement-breakpoint
UPDATE "movimentos_internos"
SET
  "de_address" = lower("de_address"),
  "para_address" = lower("para_address"),
  "tx_hash" = lower("tx_hash")
WHERE
  "de_address" <> lower("de_address")
  OR "para_address" <> lower("para_address")
  OR ("tx_hash" IS NOT NULL AND "tx_hash" <> lower("tx_hash"));
--> statement-breakpoint
UPDATE "ramp_profiles" SET "token_contract" = lower("token_contract") WHERE "token_contract" <> lower("token_contract");
--> statement-breakpoint
UPDATE "chain_cursors" SET "token_contract" = lower("token_contract") WHERE "token_contract" <> lower("token_contract");
--> statement-breakpoint
-- Ancoras antigas com contrato em checksum nao seriam encontradas pela
-- consulta lowercase. Sao cache: removemos e o monitor recria.
DELETE FROM "chain_anchors" WHERE "token_contract" <> lower("token_contract");
--> statement-breakpoint
-- Um indice HD corresponde a um unico endereco. O contador era por perfil,
-- entao dois perfis podiam alocar o mesmo indice. Mantemos uma linha por
-- indice (preferindo a que ja esta ligada a um link) antes do unique global.
WITH ranked AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY "indice"
      ORDER BY ("link_id" IS NOT NULL) DESC, "criado_em" ASC, ctid ASC
    ) AS rn
  FROM "hd_indices"
)
DELETE FROM "hd_indices" h
USING ranked r
WHERE h.ctid = r.ctid AND r.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "hd_indices_indice_uq" ON "hd_indices" USING btree ("indice");
--> statement-breakpoint
CREATE UNIQUE INDEX "links_gerados_indice_hd_uq" ON "links_gerados" USING btree ("indice_hd");
