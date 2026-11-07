ALTER TABLE "cashout_charges" ADD COLUMN "gas_topped_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cashout_charges" ADD COLUMN "gas_topup_tx_hash" text;