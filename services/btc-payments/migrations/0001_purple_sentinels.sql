ALTER TABLE "onchain_sweeps" ADD COLUMN "cold_wallet_address" text;--> statement-breakpoint
ALTER TABLE "onchain_sweeps" ADD COLUMN "inputs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "onchain_sweeps" ADD COLUMN "confirmations" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "onchain_sweeps" ADD COLUMN "last_checked_at" timestamp with time zone;