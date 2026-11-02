DROP INDEX "ledger_accounts_code_asset_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_code_asset_uq" ON "ledger_accounts" USING btree ("code","asset");