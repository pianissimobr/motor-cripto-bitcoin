-- Bloco 4: conserta os dois indices de e-mail.
--
-- 1) cadastros_prefixos tinha PK so em prefix_bidx (token HMAC do prefixo).
--    Dois clientes com o mesmo prefixo geravam o mesmo token e o segundo
--    insert era engolido por ON CONFLICT DO NOTHING (autocomplete perdia o
--    cliente). O PK passa a ser (cliente_id, prefix_bidx): o mesmo token
--    pode existir para clientes diferentes, mas nao repetido no mesmo.
ALTER TABLE cadastros_prefixos
  DROP CONSTRAINT IF EXISTS cadastros_prefixos_prefix_bidx_pk;

ALTER TABLE cadastros_prefixos
  ADD CONSTRAINT cadastros_prefixos_cliente_prefix_pk
  PRIMARY KEY (cliente_id, prefix_bidx);

CREATE INDEX IF NOT EXISTS cadastros_prefixos_prefix_idx
  ON cadastros_prefixos (prefix_bidx);

-- 2) email_bidx_v2 guardava o indice ATIVO apos a rotacao, mas o unique
--    estava em email_bidx (antigo): um e-mail duplicado podia entrar pela
--    coluna nova. Agora email_bidx e SEMPRE o indice ativo (canonico,
--    unique) e email_bidx_anterior guarda o token antigo na transicao.
ALTER TABLE cadastros RENAME COLUMN email_bidx_v2 TO email_bidx_anterior;

-- Falha explicita (em vez de erro obscuro de unique) se a base ja tiver
-- duplicados no indice ativo; o operador precisa resolve-los antes.
DO $$
DECLARE duplicado text;
BEGIN
  SELECT ativo INTO duplicado
  FROM (
    SELECT COALESCE(email_bidx_anterior, email_bidx) AS ativo, count(*) AS n
    FROM cadastros
    GROUP BY 1
    HAVING count(*) > 1
    LIMIT 1
  ) d;
  IF duplicado IS NOT NULL THEN
    RAISE EXCEPTION 'existe e-mail duplicado no indice ativo (ex.: %)', duplicado;
  END IF;
END $$;

-- Swap: o valor ativo (que estava em email_bidx_anterior) vira o canonico;
-- o antigo vai para a coluna de transicao. As expressoes usam a linha ANTIGA.
UPDATE cadastros
SET email_bidx = COALESCE(email_bidx_anterior, email_bidx),
    email_bidx_anterior = CASE
      WHEN email_bidx_anterior IS NOT NULL THEN email_bidx
      ELSE NULL
    END;

CREATE INDEX IF NOT EXISTS cadastros_email_bidx_anterior_idx
  ON cadastros (email_bidx_anterior);
