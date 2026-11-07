CREATE TABLE "swap_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"provider" text DEFAULT 'swapkit' NOT NULL,
	"provider_order_id" text,
	"provider_state" text,
	"status" text DEFAULT 'criando' NOT NULL,
	"amount_fiat_cents" bigint NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"amount_sats" bigint NOT NULL,
	"sell_asset" text NOT NULL,
	"buy_asset" text NOT NULL,
	"network" text DEFAULT 'polygon' NOT NULL,
	"destination_address" text NOT NULL,
	"deposit_address" text,
	"deposit_channel_id" text,
	"expected_asset_minor" bigint,
	"fee_total_bps" integer,
	"expires_at" timestamp with time zone,
	"provider_payload" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"metadata" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "swap_orders_status_chk" CHECK ("swap_orders"."status" in ('criando','pendente','aguardando_deposito','depositado','trocado','liquidado','expirado','reembolsado','falhou','incerto','manual')),
	CONSTRAINT "swap_orders_currency_chk" CHECK ("swap_orders"."currency" in ('BRL','USD') and "swap_orders"."network" in ('polygon')),
	CONSTRAINT "swap_orders_amount_chk" CHECK ("swap_orders"."amount_fiat_cents" > 0 and "swap_orders"."amount_sats" > 0)
);
--> statement-breakpoint
ALTER TABLE "swap_orders" ADD CONSTRAINT "swap_orders_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "swap_orders_client_external_uq" ON "swap_orders" USING btree ("client_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "swap_orders_provider_order_uq" ON "swap_orders" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "swap_orders_deposit_address_uq" ON "swap_orders" USING btree ("provider","deposit_address") WHERE "swap_orders"."deposit_address" is not null;--> statement-breakpoint
CREATE INDEX "swap_orders_status_idx" ON "swap_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "swap_orders_destination_idx" ON "swap_orders" USING btree ("destination_address");