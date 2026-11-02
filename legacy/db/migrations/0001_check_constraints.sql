-- CHECK constraints de integridade.
--
-- O drizzle desta versao nao emite `varchar(n)`, entao os limites sao
-- garantidos aqui. Isso protege indices (email_bidx tem indice unico) e
-- impede que valores fora do formato esperado entrem no banco.
--
-- Objetivo: forma de defensive validation que o schema nao cobre.

ALTER TABLE "cadastros"
  ADD CONSTRAINT "cadastros_email_bidx_len" CHECK (char_length("email_bidx") = 64),
  ADD CONSTRAINT "cadastros_status" CHECK ("status" IN ('ativo', 'inativo'));

ALTER TABLE "cadastros_prefixos"
  ADD CONSTRAINT "cadastros_prefixos_len" CHECK (char_length("prefix_bidx") = 64);

ALTER TABLE "ramp_profiles"
  ADD CONSTRAINT "ramp_profiles_param_style" CHECK ("param_style" IN ('legacy', 'unified')),
  ADD CONSTRAINT "ramp_profiles_chain_len" CHECK (char_length("chain") <= 40),
  ADD CONSTRAINT "ramp_profiles_asset_len" CHECK (char_length("asset") <= 20),
  ADD CONSTRAINT "ramp_profiles_decimals_range" CHECK ("decimals" >= 0 AND "decimals" <= 18),
  ADD CONSTRAINT "ramp_profiles_fiat_len" CHECK (char_length("fiat_currency") = 3);

ALTER TABLE "carteiras_frias"
  ADD CONSTRAINT "carteiras_frias_address_formato" CHECK ("address" ~ '^0x[0-9a-fA-F]{40}$'),
  ADD CONSTRAINT "carteiras_frias_chain_len" CHECK (char_length("chain") <= 40);

ALTER TABLE "links_gerados"
  ADD CONSTRAINT "links_gerados_endereco_formato" CHECK ("endereco_deposito" ~ '^0x[0-9a-fA-F]{40}$'),
  ADD CONSTRAINT "links_gerados_token_formato" CHECK ("token_contract" ~ '^0x[0-9a-fA-F]{40}$'),
  ADD CONSTRAINT "links_gerados_status" CHECK ("status" IN ('aguardando','pago','parcial','pago_sem_gas','movido','expirado','revogado')),
  ADD CONSTRAINT "links_gerados_valor_positivo" CHECK ("valor_fiat_centavos" > 0),
  ADD CONSTRAINT "links_gerados_indice_range" CHECK ("indice_hd" >= 0);

ALTER TABLE "links_pagos"
  ADD CONSTRAINT "links_pagos_tx_hash_formato" CHECK ("tx_hash" ~ '^0x[0-9a-fA-F]{64}$'),
  ADD CONSTRAINT "links_pagos_status" CHECK ("status" IN ('detectado','confirmado','revertido')),
  ADD CONSTRAINT "links_pagos_valor_positivo" CHECK ("valor_base_units" > 0),
  ADD CONSTRAINT "links_pagos_confirmacoes_range" CHECK ("confirmacoes" >= 0);

ALTER TABLE "creditos_cliente"
  ADD CONSTRAINT "creditos_cliente_status" CHECK ("status" IN ('pendente','liberado','revertido')),
  ADD CONSTRAINT "creditos_cliente_valor_positivo" CHECK ("valor_base_units" > 0);

ALTER TABLE "movimentos_internos"
  ADD CONSTRAINT "movimentos_internos_status" CHECK ("status" IN ('pendente','patrocinado','enviado','confirmado','falhou')),
  ADD CONSTRAINT "movimentos_internos_tx_hash_formato" CHECK ("tx_hash" IS NULL OR "tx_hash" ~ '^0x[0-9a-fA-F]{64}$');

ALTER TABLE "chain_cursors"
  ADD CONSTRAINT "chain_cursors_bloco_range" CHECK ("ultimo_bloco" >= 0);

ALTER TABLE "hd_indices"
  ADD CONSTRAINT "hd_indices_indice_range" CHECK ("indice" >= 0);
