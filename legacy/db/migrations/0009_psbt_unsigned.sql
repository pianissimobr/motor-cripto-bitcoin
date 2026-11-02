-- Payload da transacao preparada pelo modo PSBT. Fica persistido para o
-- operador recuperar a unsigned, assinar no hardware wallet e submeter o raw.
ALTER TABLE movimentos_internos
  ADD COLUMN unsigned_transaction text;
