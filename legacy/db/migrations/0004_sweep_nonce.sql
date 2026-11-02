ALTER TABLE "movimentos_internos" ADD COLUMN "nonce" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "movimentos_internos_link_nonce_uq" ON "movimentos_internos" USING btree ("link_id","nonce");