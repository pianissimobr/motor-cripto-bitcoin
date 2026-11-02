-- API-only: clientes, carteiras allowlisted, links com pagina propria,
-- liquidacao em dia util e outbox de webhook.
-- Clean-slate: as tabelas de cadastro/conta/credito/carteira fria antigas
-- nao fazem parte do novo contrato.

DROP TABLE IF EXISTS "creditos_cliente" CASCADE;
DROP TABLE IF EXISTS "cadastros_links" CASCADE;
DROP TABLE IF EXISTS "movimentos_internos" CASCADE;
DROP TABLE IF EXISTS "links_pagos" CASCADE;
DROP TABLE IF EXISTS "hd_indices" CASCADE;
DROP TABLE IF EXISTS "links_gerados" CASCADE;
DROP TABLE IF EXISTS "carteiras_frias" CASCADE;
DROP TABLE IF EXISTS "sessoes" CASCADE;
DROP TABLE IF EXISTS "contas" CASCADE;
DROP TABLE IF EXISTS "cadastros_prefixos" CASCADE;
DROP TABLE IF EXISTS "cadastros" CASCADE;
--> statement-breakpoint
CREATE TABLE "api_clientes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"webhook_url" text NOT NULL,
	"webhook_secret_enc" text NOT NULL,
	"request_secret_enc" text NOT NULL,
	"status" text DEFAULT 'ativo' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_cliente_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_cliente_id" uuid NOT NULL,
	"label" text NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_nonces" (
	"api_cliente_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	CONSTRAINT "api_nonces_api_cliente_id_nonce_pk" PRIMARY KEY("api_cliente_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "links_gerados" (
	"id" uuid PRIMARY KEY NOT NULL,
	"api_cliente_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"ramp_profile_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"asset" text NOT NULL,
	"token_contract" text NOT NULL,
	"decimals" integer DEFAULT 6 NOT NULL,
	"moeda_fiat" text NOT NULL,
	"valor_fiat_centavos" integer NOT NULL,
	"valor_fiat_unidades" integer NOT NULL,
	"taxa_token_por_fiat_base_units" bigint,
	"expected_base_units" bigint,
	"indice_hd" integer NOT NULL,
	"caminho_derivacao" text NOT NULL,
	"endereco_deposito" text NOT NULL,
	"wallet_address" text NOT NULL,
	"page_token_hash" text NOT NULL,
	"page_token_enc" text NOT NULL,
	"ramp_url" text NOT NULL,
	"status" text DEFAULT 'aguardando' NOT NULL,
	"motivo_nao_realizado" text,
	"valor_recebido_base_units" bigint DEFAULT 0 NOT NULL,
	"reembolsado" boolean DEFAULT false NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"liquidacao_ate" timestamp with time zone NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "links_pagos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"de_address" text NOT NULL,
	"para_address" text NOT NULL,
	"token" text NOT NULL,
	"valor_base_units" bigint NOT NULL,
	"confirmacoes" integer DEFAULT 0 NOT NULL,
	"bloco" integer NOT NULL,
	"status" text DEFAULT 'detectado' NOT NULL,
	"detectado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmado_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "movimentos_internos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"de_address" text NOT NULL,
	"para_address" text DEFAULT '' NOT NULL,
	"valor_base_units" bigint NOT NULL,
	"tx_hash" text,
	"status" text DEFAULT 'pendente' NOT NULL,
	"erro" text,
	"chain" text DEFAULT 'polygon' NOT NULL,
	"bloco" integer,
	"nonce" integer,
	"kind" text DEFAULT 'sweep' NOT NULL,
	"raw_transaction" text,
	"unsigned_transaction" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_cliente_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_em" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"delivered_em" timestamp with time zone,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hd_indices" (
	"scope" text NOT NULL,
	"indice" integer NOT NULL,
	"link_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hd_indices_scope_indice_pk" PRIMARY KEY("scope","indice")
);
--> statement-breakpoint
ALTER TABLE "api_cliente_wallets" ADD CONSTRAINT "api_cliente_wallets_api_cliente_id_api_clientes_id_fk" FOREIGN KEY ("api_cliente_id") REFERENCES "public"."api_clientes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_nonces" ADD CONSTRAINT "api_nonces_api_cliente_id_api_clientes_id_fk" FOREIGN KEY ("api_cliente_id") REFERENCES "public"."api_clientes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "links_gerados" ADD CONSTRAINT "links_gerados_api_cliente_id_api_clientes_id_fk" FOREIGN KEY ("api_cliente_id") REFERENCES "public"."api_clientes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "links_gerados" ADD CONSTRAINT "links_gerados_ramp_profile_id_ramp_profiles_id_fk" FOREIGN KEY ("ramp_profile_id") REFERENCES "public"."ramp_profiles"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "links_pagos" ADD CONSTRAINT "links_pagos_link_id_links_gerados_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links_gerados"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "movimentos_internos" ADD CONSTRAINT "movimentos_internos_link_id_links_gerados_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links_gerados"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_api_cliente_id_api_clientes_id_fk" FOREIGN KEY ("api_cliente_id") REFERENCES "public"."api_clientes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_link_id_links_gerados_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links_gerados"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hd_indices" ADD CONSTRAINT "hd_indices_link_id_links_gerados_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links_gerados"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "api_cliente_wallets_cliente_chain_address_uq" ON "api_cliente_wallets" USING btree ("api_cliente_id","chain","address");
--> statement-breakpoint
CREATE INDEX "api_cliente_wallets_cliente_idx" ON "api_cliente_wallets" USING btree ("api_cliente_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_clientes_api_key_hash_uq" ON "api_clientes" USING btree ("api_key_hash");
--> statement-breakpoint
CREATE INDEX "api_clientes_status_idx" ON "api_clientes" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "api_nonces_expira_em_idx" ON "api_nonces" USING btree ("expira_em");
--> statement-breakpoint
CREATE UNIQUE INDEX "hd_indices_link_uq" ON "hd_indices" USING btree ("link_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "hd_indices_indice_uq" ON "hd_indices" USING btree ("indice");
--> statement-breakpoint
CREATE UNIQUE INDEX "links_gerados_endereco_uq" ON "links_gerados" USING btree ("endereco_deposito");
--> statement-breakpoint
CREATE UNIQUE INDEX "links_gerados_indice_hd_uq" ON "links_gerados" USING btree ("indice_hd");
--> statement-breakpoint
CREATE UNIQUE INDEX "links_gerados_page_token_uq" ON "links_gerados" USING btree ("page_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "links_gerados_cliente_external_uq" ON "links_gerados" USING btree ("api_cliente_id","external_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "links_gerados_cliente_idem_uq" ON "links_gerados" USING btree ("api_cliente_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "links_gerados_cliente_idx" ON "links_gerados" USING btree ("api_cliente_id");
--> statement-breakpoint
CREATE INDEX "links_gerados_status_idx" ON "links_gerados" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "links_gerados_expira_em_idx" ON "links_gerados" USING btree ("expira_em");
--> statement-breakpoint
CREATE INDEX "links_gerados_liquidacao_ate_idx" ON "links_gerados" USING btree ("liquidacao_ate");
--> statement-breakpoint
CREATE INDEX "links_gerados_criado_em_idx" ON "links_gerados" USING btree ("criado_em");
--> statement-breakpoint
CREATE UNIQUE INDEX "links_pagos_tx_log_uq" ON "links_pagos" USING btree ("tx_hash","log_index");
--> statement-breakpoint
CREATE INDEX "links_pagos_link_idx" ON "links_pagos" USING btree ("link_id");
--> statement-breakpoint
CREATE INDEX "links_pagos_status_idx" ON "links_pagos" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "movimentos_internos_link_idx" ON "movimentos_internos" USING btree ("link_id");
--> statement-breakpoint
CREATE INDEX "movimentos_internos_status_idx" ON "movimentos_internos" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "movimentos_internos_bloco_idx" ON "movimentos_internos" USING btree ("chain","bloco");
--> statement-breakpoint
CREATE UNIQUE INDEX "movimentos_internos_link_kind_nonce_uq" ON "movimentos_internos" USING btree ("link_id","kind","nonce");
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_outbox_link_event_uq" ON "webhook_outbox" USING btree ("link_id","event_type");
--> statement-breakpoint
CREATE INDEX "webhook_outbox_due_idx" ON "webhook_outbox" USING btree ("status","next_attempt_em");
--> statement-breakpoint
CREATE INDEX "webhook_outbox_link_idx" ON "webhook_outbox" USING btree ("link_id");
