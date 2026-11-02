CREATE TABLE "subscription_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"intent_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'criada' NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_charges_status_chk" CHECK ("subscription_charges"."status" in ('criada','paga','falhou'))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount_sats" bigint NOT NULL,
	"description" text,
	"interval" text NOT NULL,
	"status" text DEFAULT 'ativa' NOT NULL,
	"external_id" text,
	"metadata" jsonb,
	"next_charge_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_interval_chk" CHECK ("subscriptions"."interval" in ('day','week','month')),
	CONSTRAINT "subscriptions_status_chk" CHECK ("subscriptions"."status" in ('ativa','pausada','cancelada','falha'))
);
--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_charges" ADD CONSTRAINT "subscription_charges_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_merchant_id_api_clients_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_charges_sub_idx" ON "subscription_charges" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_charges_intent_uq" ON "subscription_charges" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "subscriptions_merchant_idx" ON "subscriptions" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "subscriptions_next_charge_idx" ON "subscriptions" USING btree ("status","next_charge_at");