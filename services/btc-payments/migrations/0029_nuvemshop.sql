CREATE TABLE "nuvemshop_payments" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"cart_id" text NOT NULL,
	"email" text,
	"total_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"order_id" text,
	"transaction_id" text,
	"reported_status" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nuvemshop_stores" (
	"store_id" text PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"access_token_enc" text NOT NULL,
	"scope" text,
	"payment_provider_id" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "nuvemshop_payments" ADD CONSTRAINT "nuvemshop_payments_store_id_nuvemshop_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."nuvemshop_stores"("store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nuvemshop_payments" ADD CONSTRAINT "nuvemshop_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nuvemshop_stores" ADD CONSTRAINT "nuvemshop_stores_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nuvemshop_payments_open_idx" ON "nuvemshop_payments" USING btree ("store_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nuvemshop_payments_order_uq" ON "nuvemshop_payments" USING btree ("store_id","order_id");--> statement-breakpoint
CREATE INDEX "nuvemshop_stores_client_idx" ON "nuvemshop_stores" USING btree ("client_id");