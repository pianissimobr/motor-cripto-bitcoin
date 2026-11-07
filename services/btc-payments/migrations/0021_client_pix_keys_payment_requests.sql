CREATE TABLE "client_pix_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"address" text NOT NULL,
	"pix_key" text NOT NULL,
	"pix_key_type" text,
	"merchant_name" text,
	"city" text,
	"status" text DEFAULT 'ativo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_pix_keys_status_chk" CHECK ("client_pix_keys"."status" in ('ativo','inativo'))
);
--> statement-breakpoint
CREATE TABLE "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"amount_fiat_cents" bigint NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"rails" jsonb NOT NULL,
	"status" text DEFAULT 'criando' NOT NULL,
	"pix_charge_id" uuid,
	"swap_order_id" uuid,
	"pix_direct" jsonb,
	"expires_at" timestamp with time zone,
	"metadata" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requests_status_chk" CHECK ("payment_requests"."status" in ('criando','pendente','pago','parcial','expirado','cancelado','falha')),
	CONSTRAINT "payment_requests_currency_chk" CHECK ("payment_requests"."currency" in ('BRL','USD')),
	CONSTRAINT "payment_requests_amount_chk" CHECK ("payment_requests"."amount_fiat_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "client_pix_keys" ADD CONSTRAINT "client_pix_keys_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_pix_keys_client_uq" ON "client_pix_keys" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_pix_keys_address_idx" ON "client_pix_keys" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_requests_client_external_uq" ON "payment_requests" USING btree ("client_id","external_id");--> statement-breakpoint
CREATE INDEX "payment_requests_status_idx" ON "payment_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_requests_created_idx" ON "payment_requests" USING btree ("created_at");