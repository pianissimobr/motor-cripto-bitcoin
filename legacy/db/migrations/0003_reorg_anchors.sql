CREATE TABLE "chain_anchors" (
	"chain" text NOT NULL,
	"token_contract" text NOT NULL,
	"bloco" integer NOT NULL,
	"hash_bloco" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_anchors_chain_token_contract_bloco_pk" PRIMARY KEY("chain","token_contract","bloco")
);
--> statement-breakpoint
ALTER TABLE "movimentos_internos" ADD COLUMN "chain" text DEFAULT 'polygon' NOT NULL;--> statement-breakpoint
ALTER TABLE "movimentos_internos" ADD COLUMN "bloco" integer;--> statement-breakpoint
CREATE INDEX "chain_anchors_lookup_idx" ON "chain_anchors" USING btree ("chain","token_contract","bloco");--> statement-breakpoint
CREATE INDEX "movimentos_internos_bloco_idx" ON "movimentos_internos" USING btree ("chain","bloco");