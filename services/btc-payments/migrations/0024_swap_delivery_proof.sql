ALTER TABLE "swap_orders" ADD COLUMN "start_block" bigint;--> statement-breakpoint
ALTER TABLE "swap_orders" ADD COLUMN "delivery_tx_hash" text;--> statement-breakpoint
ALTER TABLE "swap_orders" ADD COLUMN "delivery_log_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "swap_orders_delivery_uq" ON "swap_orders" USING btree ("delivery_tx_hash","delivery_log_index") WHERE "swap_orders"."delivery_tx_hash" is not null;