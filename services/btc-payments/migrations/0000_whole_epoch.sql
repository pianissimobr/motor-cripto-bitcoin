CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"request_secret_enc" text NOT NULL,
	"webhook_url" text NOT NULL,
	"webhook_secret_enc" text NOT NULL,
	"status" text DEFAULT 'ativo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_clients_status_chk" CHECK ("api_clients"."status" in ('ativo', 'inativo'))
);
--> statement-breakpoint
CREATE TABLE "api_nonces" (
	"client_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_nonces_client_id_nonce_pk" PRIMARY KEY("client_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"ip" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hd_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"index" integer NOT NULL,
	"address" text NOT NULL,
	"derivation_path" text NOT NULL,
	"intent_id" uuid,
	"status" text DEFAULT 'alocada' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "hd_addresses_status_chk" CHECK ("hd_addresses"."status" in ('alocada', 'usada', 'abandonada', 'sweepada'))
);
--> statement-breakpoint
CREATE TABLE "hd_wallet_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"next_receive_index" integer DEFAULT 0 NOT NULL,
	"gap_limit" integer DEFAULT 20 NOT NULL,
	"xpub_fingerprint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hd_wallet_state_singleton_chk" CHECK ("hd_wallet_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "lightning_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"payment_hash" text NOT NULL,
	"invoice" text NOT NULL,
	"amount_sats" bigint NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"paid_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lightning_payments_status_chk" CHECK ("lightning_payments"."status" in ('pendente','pago','expirado','falhou'))
);
--> statement-breakpoint
CREATE TABLE "onchain_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"txid" text NOT NULL,
	"vout" integer NOT NULL,
	"amount_sats" bigint NOT NULL,
	"block_height" integer,
	"block_hash" text,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'mempool' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onchain_payments_status_chk" CHECK ("onchain_payments"."status" in ('mempool','confirmado','reorg','gasto')),
	CONSTRAINT "onchain_payments_vout_chk" CHECK ("onchain_payments"."vout" >= 0),
	CONSTRAINT "onchain_payments_amount_chk" CHECK ("onchain_payments"."amount_sats" > 0)
);
--> statement-breakpoint
CREATE TABLE "onchain_sweeps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"txid" text,
	"amount_sats" bigint NOT NULL,
	"fee_sats" bigint,
	"status" text DEFAULT 'pendente' NOT NULL,
	"psbt" text,
	"raw_tx" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onchain_sweeps_status_chk" CHECK ("onchain_sweeps"."status" in ('nao_aplicavel','aguardando_confirmacao','pendente','construindo','assinando','transmitindo','aguardando_confirmacao_rede','sweepado','falhou','manual','substituido'))
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"amount_sats" bigint NOT NULL,
	"description" text,
	"status" text DEFAULT 'criando' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"grace_until" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_rail" text,
	"paid_amount_sats" bigint,
	"overpaid_sats" bigint,
	"lightning_payment_hash" text,
	"lightning_invoice" text,
	"lightning_expires_at" timestamp with time zone,
	"onchain_address_id" uuid,
	"metadata" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_status_chk" CHECK ("payment_intents"."status" in ('criando','pendente','pago','parcial','expirado','pago_tardio','cancelado','reorg','falha_criacao')),
	CONSTRAINT "payment_intents_paid_rail_chk" CHECK ("payment_intents"."paid_rail" is null or "payment_intents"."paid_rail" in ('lightning','onchain','both')),
	CONSTRAINT "payment_intents_amount_chk" CHECK ("payment_intents"."amount_sats" > 0)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "webhook_events_status_chk" CHECK ("webhook_events"."status" in ('pendente','entregue','falhou'))
);
--> statement-breakpoint
ALTER TABLE "api_nonces" ADD CONSTRAINT "api_nonces_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lightning_payments" ADD CONSTRAINT "lightning_payments_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_payments" ADD CONSTRAINT "onchain_payments_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_payments" ADD CONSTRAINT "onchain_payments_address_id_hd_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."hd_addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_sweeps" ADD CONSTRAINT "onchain_sweeps_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_sweeps" ADD CONSTRAINT "onchain_sweeps_address_id_hd_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."hd_addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_onchain_address_id_hd_addresses_id_fk" FOREIGN KEY ("onchain_address_id") REFERENCES "public"."hd_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_key_hash_uq" ON "api_clients" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX "api_clients_prefix_idx" ON "api_clients" USING btree ("api_key_prefix");--> statement-breakpoint
CREATE INDEX "api_nonces_expires_idx" ON "api_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hd_addresses_index_uq" ON "hd_addresses" USING btree ("index");--> statement-breakpoint
CREATE UNIQUE INDEX "hd_addresses_address_uq" ON "hd_addresses" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "hd_addresses_intent_uq" ON "hd_addresses" USING btree ("intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lightning_payments_hash_uq" ON "lightning_payments" USING btree ("payment_hash");--> statement-breakpoint
CREATE INDEX "lightning_payments_intent_idx" ON "lightning_payments" USING btree ("intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onchain_payments_txid_vout_uq" ON "onchain_payments" USING btree ("txid","vout");--> statement-breakpoint
CREATE INDEX "onchain_payments_intent_idx" ON "onchain_payments" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "onchain_payments_address_idx" ON "onchain_payments" USING btree ("address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onchain_sweeps_txid_uq" ON "onchain_sweeps" USING btree ("txid");--> statement-breakpoint
CREATE INDEX "onchain_sweeps_status_idx" ON "onchain_sweeps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "onchain_sweeps_intent_idx" ON "onchain_sweeps" USING btree ("intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_client_external_uq" ON "payment_intents" USING btree ("client_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_lightning_hash_uq" ON "payment_intents" USING btree ("lightning_payment_hash");--> statement-breakpoint
CREATE INDEX "payment_intents_status_expires_idx" ON "payment_intents" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "payment_intents_status_grace_idx" ON "payment_intents" USING btree ("status","grace_until");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_job_idx" ON "reconciliation_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_dedupe_uq" ON "webhook_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "webhook_events_due_idx" ON "webhook_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_events_intent_idx" ON "webhook_events" USING btree ("intent_id");