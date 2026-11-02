CREATE TABLE "pix_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"provider" text DEFAULT 'lunium' NOT NULL,
	"provider_external_id" text NOT NULL,
	"provider_charge_id" text,
	"provider_status" text,
	"provider_settlement_status" text,
	"status" text DEFAULT 'criando' NOT NULL,
	"amount_brl_cents" bigint NOT NULL,
	"asset" text DEFAULT 'USDC' NOT NULL,
	"chain" text DEFAULT 'base' NOT NULL,
	"destination_address" text,
	"qr_copypaste" text,
	"qr_image_url" text,
	"expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"e2e" text,
	"payer_name" text,
	"payer_tax_hash" text,
	"payer_tax_last4" text,
	"fee_lunium_bps" integer,
	"fee_lunium_fixed_cents" bigint,
	"fee_partner_bps" integer,
	"fee_total_cents" bigint,
	"net_cents" bigint,
	"asset_amount_minor" bigint,
	"withdraw_fee" text,
	"settlement_tx_hash" text,
	"settlement_tx_url" text,
	"provider_payload" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"payout_id" uuid,
	"metadata" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pix_charges_status_chk" CHECK ("pix_charges"."status" in ('criando','pendente','pago','liquidado','expirado','reembolsado','falhou','incerto','manual')),
	CONSTRAINT "pix_charges_provider_status_chk" CHECK ("pix_charges"."provider_status" is null or "pix_charges"."provider_status" in ('pending','delayed','under_review','paid','expired','refunded','failed')),
	CONSTRAINT "pix_charges_provider_settlement_chk" CHECK ("pix_charges"."provider_settlement_status" is null or "pix_charges"."provider_settlement_status" in ('pending','sending','entregando','sent','incerto','failed')),
	CONSTRAINT "pix_charges_amount_chk" CHECK ("pix_charges"."amount_brl_cents" > 0),
	CONSTRAINT "pix_charges_asset_chk" CHECK ("pix_charges"."asset" in ('USDC') and "pix_charges"."chain" in ('base'))
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "intent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "pix_charge_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_events" ADD COLUMN "pix_charge_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "pix_charge_id" uuid;--> statement-breakpoint
ALTER TABLE "pix_charges" ADD CONSTRAINT "pix_charges_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pix_charges_client_external_uq" ON "pix_charges" USING btree ("client_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pix_charges_provider_external_uq" ON "pix_charges" USING btree ("provider","provider_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pix_charges_provider_charge_uq" ON "pix_charges" USING btree ("provider","provider_charge_id");--> statement-breakpoint
CREATE INDEX "pix_charges_status_idx" ON "pix_charges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pix_charges_settlement_status_idx" ON "pix_charges" USING btree ("status","provider_settlement_status");--> statement-breakpoint
CREATE INDEX "pix_charges_payout_idx" ON "pix_charges" USING btree ("payout_id");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_pix_charge_id_pix_charges_id_fk" FOREIGN KEY ("pix_charge_id") REFERENCES "public"."pix_charges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_pix_charge_id_pix_charges_id_fk" FOREIGN KEY ("pix_charge_id") REFERENCES "public"."pix_charges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_pix_charge_id_pix_charges_id_fk" FOREIGN KEY ("pix_charge_id") REFERENCES "public"."pix_charges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_pix_charge_uq" ON "payouts" USING btree ("pix_charge_id");--> statement-breakpoint
CREATE INDEX "provider_events_pix_charge_idx" ON "provider_events" USING btree ("pix_charge_id");--> statement-breakpoint
CREATE INDEX "webhook_events_pix_charge_idx" ON "webhook_events" USING btree ("pix_charge_id");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_source_chk" CHECK ((("payouts"."conversion_id" is not null)::int + ("payouts"."pix_charge_id" is not null)::int) = 1);--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_source_chk" CHECK ((("webhook_events"."intent_id" is not null)::int + ("webhook_events"."pix_charge_id" is not null)::int) = 1);