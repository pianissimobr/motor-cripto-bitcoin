CREATE TABLE "address_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"merchant_id" uuid,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "possession_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text NOT NULL,
	"address" text NOT NULL,
	"purpose" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "possession_challenges_purpose_chk" CHECK ("possession_challenges"."purpose" in ('client_registration','wallet_registration'))
);
--> statement-breakpoint
CREATE TABLE "service_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "address_revocations" ADD CONSTRAINT "address_revocations_merchant_id_api_clients_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "address_revocations_address_merchant_uq" ON "address_revocations" USING btree ("address","merchant_id");--> statement-breakpoint
CREATE INDEX "address_revocations_address_idx" ON "address_revocations" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "possession_challenges_nonce_uq" ON "possession_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "possession_challenges_address_idx" ON "possession_challenges" USING btree ("address");--> statement-breakpoint
CREATE INDEX "possession_challenges_expires_idx" ON "possession_challenges" USING btree ("expires_at");