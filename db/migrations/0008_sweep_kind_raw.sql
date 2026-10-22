-- Separa sweep do token, dust nativo e recuperacao sintetica, e permite
-- retomar uma transacao assinada depois de um crash antes do broadcast.
ALTER TABLE movimentos_internos
  ADD COLUMN kind text NOT NULL DEFAULT 'sweep';

ALTER TABLE movimentos_internos
  ADD COLUMN raw_transaction text;

UPDATE movimentos_internos
SET kind = 'dust'
WHERE erro LIKE 'retorno de gas nativo%';

-- A idempotencia passa a considerar o tipo: um dust no mesmo nonce do
-- sweep nao pode mais bloquear o proximo sweep do link.
DROP INDEX IF EXISTS movimentos_internos_link_nonce_uq;

CREATE UNIQUE INDEX movimentos_internos_link_kind_nonce_uq
  ON movimentos_internos (link_id, kind, nonce);

ALTER TABLE movimentos_internos
  ADD CONSTRAINT movimentos_internos_kind_check
  CHECK (kind IN ('sweep', 'dust', 'recovery'));

ALTER TABLE movimentos_internos
  ADD CONSTRAINT movimentos_internos_raw_tx_formato
  CHECK (raw_transaction IS NULL OR raw_transaction ~ '^0x([0-9a-fA-F]{2})*$');
