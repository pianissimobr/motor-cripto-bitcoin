ALTER TABLE "cadastros" ADD COLUMN "email_bidx_v2" text;--> statement-breakpoint
ALTER TABLE "cadastros_prefixos" ADD COLUMN "prefix_bidx_v2" text;--> statement-breakpoint
CREATE INDEX "cadastros_prefixos_v2_idx" ON "cadastros_prefixos" USING btree ("prefix_bidx_v2");