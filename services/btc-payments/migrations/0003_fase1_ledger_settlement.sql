CREATE TABLE "conversion_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversion_id" uuid NOT NULL,
	"leg" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"txid" text,
	"provider_ref" text,
	"amount_in" bigint,
	"amount_out" bigint,
	"fee_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversion_legs_leg_chk" CHECK ("conversion_legs"."leg" in ('thorchain','cctp_burn','cctp_mint','payout')),
	CONSTRAINT "conversion_legs_status_chk" CHECK ("conversion_legs"."status" in ('pendente','enviado','confirmado','falhou','manual'))
);
--> statement-breakpoint
CREATE TABLE "conversion_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"fx_quote_id" uuid,
	"source_asset" text DEFAULT 'BTC' NOT NULL,
	"source_amount_sats" bigint NOT NULL,
	"target_asset" text DEFAULT 'USDC' NOT NULL,
	"target_chain" text DEFAULT 'base' NOT NULL,
	"target_amount_minor" bigint,
	"provider" text NOT NULL,
	"provider_order_id" text,
	"status" text DEFAULT 'criada' NOT NULL,
	"fee_sats" bigint,
	"fee_minor" bigint,
	"txids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversion_orders_status_chk" CHECK ("conversion_orders"."status" in ('criada','cotando','enviando_btc','aguardando_swap','recebendo_usdc','convertida','falhou','reembolsada','manual')),
	CONSTRAINT "conversion_orders_asset_chk" CHECK ("conversion_orders"."source_asset" in ('BTC') and "conversion_orders"."target_asset" in ('USDC')),
	CONSTRAINT "conversion_orders_amount_chk" CHECK ("conversion_orders"."source_amount_sats" > 0)
);
--> statement-breakpoint
CREATE TABLE "fx_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"base_currency" text NOT NULL,
	"quote_asset" text NOT NULL,
	"amount_in" bigint NOT NULL,
	"amount_out" bigint NOT NULL,
	"rate" numeric(38, 18) NOT NULL,
	"spread_bps" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'ativa' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_quotes_currency_chk" CHECK ("fx_quotes"."base_currency" in ('BRL','USD') and "fx_quotes"."quote_asset" in ('BTC')),
	CONSTRAINT "fx_quotes_amounts_chk" CHECK ("fx_quotes"."amount_in" > 0 and "fx_quotes"."amount_out" > 0),
	CONSTRAINT "fx_quotes_spread_chk" CHECK ("fx_quotes"."spread_bps" >= 0),
	CONSTRAINT "fx_quotes_status_chk" CHECK ("fx_quotes"."status" in ('ativa','usada','expirada','cancelada'))
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text NOT NULL,
	"rate" numeric(38, 18) NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_currency_chk" CHECK ("fx_rates"."base_currency" in ('BTC','BRL','USD') and "fx_rates"."quote_currency" in ('BTC','BRL','USD')),
	CONSTRAINT "fx_rates_positive_chk" CHECK ("fx_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid,
	"code" text NOT NULL,
	"asset" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_asset_chk" CHECK ("ledger_accounts"."asset" in ('BTC','BRL','USD','USDC')),
	CONSTRAINT "ledger_accounts_kind_chk" CHECK ("ledger_accounts"."kind" in ('asset','liability','revenue','expense','equity'))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"debit_minor" bigint DEFAULT 0 NOT NULL,
	"credit_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_asset_chk" CHECK ("ledger_entries"."asset" in ('BTC','BRL','USD','USDC')),
	CONSTRAINT "ledger_entries_amount_chk" CHECK ("ledger_entries"."debit_minor" >= 0 and "ledger_entries"."credit_minor" >= 0 and (("ledger_entries"."debit_minor" > 0 and "ledger_entries"."credit_minor" = 0) or ("ledger_entries"."credit_minor" > 0 and "ledger_entries"."debit_minor" = 0)))
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_wallet_state" (
	"wallet_id" uuid PRIMARY KEY NOT NULL,
	"next_receive_index" integer DEFAULT 0 NOT NULL,
	"gap_limit" integer DEFAULT 20 NOT NULL,
	"xpub_fingerprint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_wallet_state_next_index_chk" CHECK ("merchant_wallet_state"."next_receive_index" >= 0),
	CONSTRAINT "merchant_wallet_state_gap_limit_chk" CHECK ("merchant_wallet_state"."gap_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "merchant_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid,
	"kind" text NOT NULL,
	"chain" text NOT NULL,
	"network" text NOT NULL,
	"address" text NOT NULL,
	"xpub" text,
	"derivation_prefix" text,
	"status" text DEFAULT 'ativo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_wallets_kind_chk" CHECK ("merchant_wallets"."kind" in ('btc_deposit', 'usdc_settlement', 'btc_cold')),
	CONSTRAINT "merchant_wallets_status_chk" CHECK ("merchant_wallets"."status" in ('ativo', 'inativo'))
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"conversion_id" uuid,
	"wallet_id" uuid,
	"asset" text DEFAULT 'USDC' NOT NULL,
	"chain" text DEFAULT 'base' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"fee_minor" bigint,
	"status" text DEFAULT 'pendente' NOT NULL,
	"txid" text,
	"idempotency_key" text NOT NULL,
	"approved_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "payouts_status_chk" CHECK ("payouts"."status" in ('pendente','aprovado','enviando','confirmado','retido','falhou','cancelado')),
	CONSTRAINT "payouts_asset_chk" CHECK ("payouts"."asset" in ('USDC') and "payouts"."chain" in ('base')),
	CONSTRAINT "payouts_amount_chk" CHECK ("payouts"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_type" text NOT NULL,
	"external_id" text NOT NULL,
	"conversion_id" uuid,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"chain" text NOT NULL,
	"network" text NOT NULL,
	"address" text NOT NULL,
	"xpub" text,
	"status" text DEFAULT 'ativo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_wallets_kind_chk" CHECK ("treasury_wallets"."kind" in ('btc_hot','btc_cold','usdc_hot','gas_base')),
	CONSTRAINT "treasury_wallets_status_chk" CHECK ("treasury_wallets"."status" in ('ativo','inativo'))
);
--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "base_currency" text DEFAULT 'BRL' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "settlement_asset" text DEFAULT 'USDC' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "settlement_chain" text DEFAULT 'base' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "spread_bps" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "auto_payout_limit_brl" bigint DEFAULT 1000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "auto_payout_limit_usd" bigint DEFAULT 200000 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "unverified_daily_limit_brl" bigint DEFAULT 1000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "unverified_total_limit_brl" bigint DEFAULT 1000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "verification_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "payout_batch_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hd_addresses" ADD COLUMN "merchant_wallet_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "merchant_wallet_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "amount_fiat" bigint;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "fx_quote_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "settlement_status" text DEFAULT 'nao_iniciado' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "conversion_order_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "payout_id" uuid;--> statement-breakpoint
ALTER TABLE "conversion_legs" ADD CONSTRAINT "conversion_legs_conversion_id_conversion_orders_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."conversion_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_orders" ADD CONSTRAINT "conversion_orders_merchant_id_api_clients_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."api_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_orders" ADD CONSTRAINT "conversion_orders_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_orders" ADD CONSTRAINT "conversion_orders_fx_quote_id_fx_quotes_id_fk" FOREIGN KEY ("fx_quote_id") REFERENCES "public"."fx_quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_merchant_id_api_clients_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_merchant_id_api_clients_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."api_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_wallet_state" ADD CONSTRAINT "merchant_wallet_state_wallet_id_merchant_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."merchant_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_wallets" ADD CONSTRAINT "merchant_wallets_merchant_id_api_clients_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_merchant_id_api_clients_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."api_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_conversion_id_conversion_orders_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."conversion_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_wallet_id_merchant_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."merchant_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_conversion_id_conversion_orders_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."conversion_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_legs_conversion_leg_uq" ON "conversion_legs" USING btree ("conversion_id","leg");--> statement-breakpoint
CREATE INDEX "conversion_legs_status_idx" ON "conversion_legs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_orders_intent_uq" ON "conversion_orders" USING btree ("intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_orders_provider_order_uq" ON "conversion_orders" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE INDEX "conversion_orders_merchant_idx" ON "conversion_orders" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "conversion_orders_status_idx" ON "conversion_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fx_quotes_merchant_idx" ON "fx_quotes" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "fx_quotes_status_expires_idx" ON "fx_quotes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "fx_rates_pair_idx" ON "fx_rates" USING btree ("base_currency","quote_currency","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_code_asset_uq" ON "ledger_accounts" USING btree ("merchant_id","code","asset");--> statement-breakpoint
CREATE INDEX "ledger_accounts_merchant_idx" ON "ledger_accounts" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_reference_idx" ON "ledger_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_created_idx" ON "ledger_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "merchant_wallets_merchant_idx" ON "merchant_wallets" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "merchant_wallets_kind_idx" ON "merchant_wallets" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_wallets_chain_address_uq" ON "merchant_wallets" USING btree ("chain","address");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_idempotency_uq" ON "payouts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payouts_merchant_idx" ON "payouts" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_external_uq" ON "provider_events" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "provider_events_conversion_idx" ON "provider_events" USING btree ("conversion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_wallets_chain_address_uq" ON "treasury_wallets" USING btree ("chain","address");--> statement-breakpoint
ALTER TABLE "hd_addresses" ADD CONSTRAINT "hd_addresses_merchant_wallet_id_merchant_wallets_id_fk" FOREIGN KEY ("merchant_wallet_id") REFERENCES "public"."merchant_wallets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_merchant_wallet_id_merchant_wallets_id_fk" FOREIGN KEY ("merchant_wallet_id") REFERENCES "public"."merchant_wallets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_intents_merchant_wallet_idx" ON "payment_intents" USING btree ("merchant_wallet_id");--> statement-breakpoint
CREATE INDEX "payment_intents_settlement_status_idx" ON "payment_intents" USING btree ("settlement_status");--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_verification_chk" CHECK ("api_clients"."verification_status" in ('unverified', 'pending', 'verified'));--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_base_currency_chk" CHECK ("api_clients"."base_currency" in ('BRL', 'USD'));--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_settlement_asset_chk" CHECK ("api_clients"."settlement_asset" in ('USDC'));--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_payout_batch_chk" CHECK ("api_clients"."payout_batch_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_settlement_status_chk" CHECK ("payment_intents"."settlement_status" in ('nao_iniciado','aguardando_confirmacao','pronto_para_conversao','convertendo','convertido','payout_pendente','pago','falhou','manual'));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_currency_chk" CHECK ("payment_intents"."currency" is null or "payment_intents"."currency" in ('BRL','USD'));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_amount_fiat_chk" CHECK ("payment_intents"."amount_fiat" is null or "payment_intents"."amount_fiat" > 0);