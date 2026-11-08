CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"store_key_id" uuid,
	"mode" text NOT NULL,
	"order_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"description" text,
	"customer_email" text,
	"success_url" text,
	"cancel_url" text,
	"ipn_url" text,
	"rails" jsonb NOT NULL,
	"status" text DEFAULT 'aguardando' NOT NULL,
	"pix_charge_id" uuid,
	"swap_order_id" uuid,
	"test_rail" text,
	"paid_rail" text,
	"tx_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_mode_chk" CHECK ("invoices"."mode" in ('live','test')),
	CONSTRAINT "invoices_status_chk" CHECK ("invoices"."status" in ('aguardando','confirmando','pago','expirado','cancelado')),
	CONSTRAINT "invoices_currency_chk" CHECK ("invoices"."currency" in ('BRL','USD'))
);
--> statement-breakpoint
CREATE TABLE "store_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"label" text,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"ipn_secret_enc" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_keys_mode_chk" CHECK ("store_keys"."mode" in ('live','test'))
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "target_url" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "store_key_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_store_key_id_store_keys_id_fk" FOREIGN KEY ("store_key_id") REFERENCES "public"."store_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pix_charge_id_pix_charges_id_fk" FOREIGN KEY ("pix_charge_id") REFERENCES "public"."pix_charges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_swap_order_id_swap_orders_id_fk" FOREIGN KEY ("swap_order_id") REFERENCES "public"."swap_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_keys" ADD CONSTRAINT "store_keys_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_order_uq" ON "invoices" USING btree ("client_id","mode","order_id");--> statement-breakpoint
CREATE INDEX "invoices_open_idx" ON "invoices" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "invoices_client_created_idx" ON "invoices" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "store_keys_hash_uq" ON "store_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "store_keys_client_idx" ON "store_keys" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_store_key_id_store_keys_id_fk" FOREIGN KEY ("store_key_id") REFERENCES "public"."store_keys"("id") ON DELETE set null ON UPDATE no action;