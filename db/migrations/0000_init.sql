CREATE TABLE "cadastros" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nome_enc" text NOT NULL,
	"email_enc" text NOT NULL,
	"email_bidx" text NOT NULL,
	"nome_masked" text NOT NULL,
	"email_masked" text NOT NULL,
	"status" text DEFAULT 'ativo' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cadastros_links" (
	"cliente_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cadastros_links_cliente_id_link_id_pk" PRIMARY KEY("cliente_id","link_id")
);
--> statement-breakpoint
CREATE TABLE "cadastros_prefixos" (
	"prefix_bidx" text NOT NULL,
	"cliente_id" uuid NOT NULL,
	CONSTRAINT "cadastros_prefixos_prefix_bidx_pk" PRIMARY KEY("prefix_bidx")
);
--> statement-breakpoint
CREATE TABLE "carteiras_frias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"chain" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"chain" text NOT NULL,
	"token_contract" text NOT NULL,
	"ultimo_bloco" integer DEFAULT 0 NOT NULL,
	"hash_bloco" text,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_cursors_chain_token_contract_pk" PRIMARY KEY("chain","token_contract")
);
--> statement-breakpoint
CREATE TABLE "creditos_cliente" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"pagamento_id" uuid NOT NULL,
	"valor_base_units" bigint NOT NULL,
	"valor_centavos" integer,
	"moeda" text NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eventos_auditoria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ator" text NOT NULL,
	"acao" text NOT NULL,
	"entidade" text NOT NULL,
	"entidade_id" text,
	"detalhes" text,
	"ip" text,
	"hash_anterior" text,
	"hash" text,
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
CREATE TABLE "links_gerados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliente_id" uuid NOT NULL,
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
	"ramp_url" text NOT NULL,
	"status" text DEFAULT 'aguardando' NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
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
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ramp_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"chain" text NOT NULL,
	"asset" text NOT NULL,
	"token_contract" text NOT NULL,
	"decimals" integer DEFAULT 6 NOT NULL,
	"fiat_currency" text DEFAULT 'BRL' NOT NULL,
	"base_url" text NOT NULL,
	"param_style" text DEFAULT 'legacy' NOT NULL,
	"host_app_name" text DEFAULT 'Motor Cripto' NOT NULL,
	"host_logo_url" text,
	"host_api_key_enc" text,
	"ramp_asset_key" text,
	"taxa_token_por_fiat_base_units" bigint,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cadastros_links" ADD CONSTRAINT "cadastros_links_cliente_id_cadastros_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."cadastros"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cadastros_links" ADD CONSTRAINT "cadastros_links_link_id_links_gerados_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links_gerados"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cadastros_prefixos" ADD CONSTRAINT "cadastros_prefixos_cliente_id_cadastros_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."cadastros"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creditos_cliente" ADD CONSTRAINT "creditos_cliente_cliente_id_cadastros_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."cadastros"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creditos_cliente" ADD CONSTRAINT "creditos_cliente_link_id_links_gerados_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links_gerados"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creditos_cliente" ADD CONSTRAINT "creditos_cliente_pagamento_id_links_pagos_id_fk" FOREIGN KEY ("pagamento_id") REFERENCES "public"."links_pagos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hd_indices" ADD CONSTRAINT "hd_indices_link_id_links_gerados_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links_gerados"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links_gerados" ADD CONSTRAINT "links_gerados_cliente_id_cadastros_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."cadastros"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links_gerados" ADD CONSTRAINT "links_gerados_ramp_profile_id_ramp_profiles_id_fk" FOREIGN KEY ("ramp_profile_id") REFERENCES "public"."ramp_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links_pagos" ADD CONSTRAINT "links_pagos_link_id_links_gerados_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links_gerados"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_internos" ADD CONSTRAINT "movimentos_internos_link_id_links_gerados_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links_gerados"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cadastros_email_bidx_uq" ON "cadastros" USING btree ("email_bidx");--> statement-breakpoint
CREATE INDEX "cadastros_criado_em_idx" ON "cadastros" USING btree ("criado_em");--> statement-breakpoint
CREATE INDEX "cadastros_prefixos_cliente_idx" ON "cadastros_prefixos" USING btree ("cliente_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carteiras_frias_address_uq" ON "carteiras_frias" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "carteiras_frias_label_uq" ON "carteiras_frias" USING btree ("label");--> statement-breakpoint
CREATE UNIQUE INDEX "creditos_cliente_pagamento_uq" ON "creditos_cliente" USING btree ("pagamento_id");--> statement-breakpoint
CREATE INDEX "creditos_cliente_cliente_idx" ON "creditos_cliente" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "eventos_auditoria_criado_em_idx" ON "eventos_auditoria" USING btree ("criado_em");--> statement-breakpoint
CREATE INDEX "eventos_auditoria_entidade_idx" ON "eventos_auditoria" USING btree ("entidade","entidade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hd_indices_link_uq" ON "hd_indices" USING btree ("link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "links_gerados_endereco_uq" ON "links_gerados" USING btree ("endereco_deposito");--> statement-breakpoint
CREATE INDEX "links_gerados_cliente_idx" ON "links_gerados" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "links_gerados_status_idx" ON "links_gerados" USING btree ("status");--> statement-breakpoint
CREATE INDEX "links_gerados_criado_em_idx" ON "links_gerados" USING btree ("criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "links_pagos_tx_log_uq" ON "links_pagos" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "links_pagos_link_idx" ON "links_pagos" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "links_pagos_status_idx" ON "links_pagos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "movimentos_internos_link_idx" ON "movimentos_internos" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "movimentos_internos_status_idx" ON "movimentos_internos" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ramp_profiles_label_uq" ON "ramp_profiles" USING btree ("label");