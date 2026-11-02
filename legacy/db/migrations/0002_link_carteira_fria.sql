ALTER TABLE "links_gerados" ADD COLUMN "carteira_fria_id" uuid;--> statement-breakpoint
ALTER TABLE "links_gerados" ADD COLUMN "carteira_fria_endereco" text;--> statement-breakpoint
ALTER TABLE "links_gerados" ADD CONSTRAINT "links_gerados_carteira_fria_id_carteiras_frias_id_fk" FOREIGN KEY ("carteira_fria_id") REFERENCES "public"."carteiras_frias"("id") ON DELETE set null ON UPDATE no action;