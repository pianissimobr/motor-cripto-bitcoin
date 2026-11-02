DROP INDEX "hd_addresses_wallet_index_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "hd_addresses_default_index_uq" ON "hd_addresses" USING btree ("index") WHERE "hd_addresses"."merchant_wallet_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "hd_addresses_wallet_index_uq" ON "hd_addresses" USING btree ("merchant_wallet_id","index") WHERE "hd_addresses"."merchant_wallet_id" is not null;