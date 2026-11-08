ALTER TABLE "invoices" ADD COLUMN "usdc_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "usdc_address" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "usdc_start_block" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "usdc_scanned_block" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "usdc_tx_hash" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "usdc_log_index" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pix_direto_txid" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pix_direto_copypaste" text;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_usdc_transfer_uq" ON "invoices" USING btree ("usdc_tx_hash","usdc_log_index");