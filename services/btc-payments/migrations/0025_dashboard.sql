ALTER TABLE "merchant_wallets" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "merchant_wallets" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip" text;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_wallets_default_uq" ON "merchant_wallets" USING btree ("merchant_id","kind","chain") WHERE "merchant_wallets"."is_default" and "merchant_wallets"."status" = 'ativo';