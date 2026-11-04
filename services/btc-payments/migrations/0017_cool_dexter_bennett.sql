CREATE TABLE "cashout_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"provider" text DEFAULT 'lunium' NOT NULL,
	"provider_external_id" text NOT NULL,
	"provider_cashout_id" text,
	"provider_state" text,
	"status" text DEFAULT 'criando' NOT NULL,
	"amount_brl_cents" bigint NOT NULL,
	"asset" text DEFAULT 'USDC' NOT NULL,
	"network" text DEFAULT 'polygon' NOT NULL,
	"origin_address" text NOT NULL,
	"deposit_address" text,
	"deposit_tag" text,
	"amount_asset_minor" bigint,
	"fee_total_cents" bigint,
	"pix_key_masked" text,
	"pix_key_type" text,
	"br_code" text,
	"provider_path" text,
	"tx_hash" text,
	"pix_e2e" text,
	"pix_paid_at" timestamp with time zone,
	"receipt_url" text,
	"verify_url" text,
	"refund_address" text,
	"provider_payload" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"metadata" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cashout_charges_status_chk" CHECK ("cashout_charges"."status" in ('criando','pendente','aguardando_deposito','depositado','pago','liquidado','expirado','reembolsado','falhou','incerto','manual')),
	CONSTRAINT "cashout_charges_asset_chk" CHECK ("cashout_charges"."asset" in ('USDC') and "cashout_charges"."network" in ('polygon')),
	CONSTRAINT "cashout_charges_amount_chk" CHECK ("cashout_charges"."amount_brl_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "client_type" text DEFAULT 'loja' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "settlement_address" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "cashout_charge_id" uuid;--> statement-breakpoint
ALTER TABLE "cashout_charges" ADD CONSTRAINT "cashout_charges_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cashout_charges_client_external_uq" ON "cashout_charges" USING btree ("client_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cashout_charges_provider_external_uq" ON "cashout_charges" USING btree ("provider","provider_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cashout_charges_provider_cashout_uq" ON "cashout_charges" USING btree ("provider","provider_cashout_id");--> statement-breakpoint
CREATE INDEX "cashout_charges_status_idx" ON "cashout_charges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cashout_charges_origin_idx" ON "cashout_charges" USING btree ("origin_address");--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_cashout_charge_id_cashout_charges_id_fk" FOREIGN KEY ("cashout_charge_id") REFERENCES "public"."cashout_charges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_settlement_address_uq" ON "api_clients" USING btree ("settlement_address") WHERE "api_clients"."settlement_address" is not null;