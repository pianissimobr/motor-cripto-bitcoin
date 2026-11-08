CREATE TABLE "merchant_pix_banks" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"psp" text NOT NULL,
	"environment" text NOT NULL,
	"base_url" text,
	"token_url" text,
	"oauth_client_id" text NOT NULL,
	"oauth_client_secret_enc" text NOT NULL,
	"certificate_enc" text NOT NULL,
	"certificate_passphrase_enc" text,
	"pix_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_check_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_pix_banks_psp_chk" CHECK ("merchant_pix_banks"."psp" in ('efi','inter','outro')),
	CONSTRAINT "merchant_pix_banks_env_chk" CHECK ("merchant_pix_banks"."environment" in ('producao','homologacao'))
);
--> statement-breakpoint
ALTER TABLE "merchant_pix_banks" ADD CONSTRAINT "merchant_pix_banks_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;