ALTER TABLE "conversion_orders" ADD COLUMN "inbound_address" text;--> statement-breakpoint
ALTER TABLE "conversion_orders" ADD COLUMN "memo" text;--> statement-breakpoint
ALTER TABLE "conversion_orders" ADD COLUMN "quote_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversion_orders" ADD COLUMN "provider_payload" jsonb;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "destination_address" text;