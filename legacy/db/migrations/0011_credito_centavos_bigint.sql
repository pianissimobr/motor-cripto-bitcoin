-- Centavos do credito cabem em valores grandes (um pagamento acima de ~R$ 21 mi
-- estourava integer e travava a confirmacao da fila inteira).
ALTER TABLE creditos_cliente
  ALTER COLUMN valor_centavos TYPE bigint;
