-- E3: os tokens de prefixo na versao 2 sao gravados com o prefixo
-- literal "v2:" para nao colidirem no primary key com os tokens antigos.
-- O CHECK precisa aceitar esse formato (67 chars em vez de 64).

ALTER TABLE "cadastros_prefixos" DROP CONSTRAINT IF EXISTS "cadastros_prefixos_len";

ALTER TABLE "cadastros_prefixos"
  ADD CONSTRAINT "cadastros_prefixos_len" CHECK (
    char_length("prefix_bidx") = 64
    OR ("prefix_bidx" LIKE 'v2:%' AND char_length("prefix_bidx") = 67)
  );
