DROP INDEX "hd_addresses_index_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "hd_addresses_wallet_index_uq" ON "hd_addresses" USING btree ("merchant_wallet_id","index");