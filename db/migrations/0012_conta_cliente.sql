-- Conta do cliente (usuario + senha) e sessao, separados do ADMIN_TOKEN.
CREATE TABLE contas (
  cliente_id uuid PRIMARY KEY REFERENCES cadastros(id) ON DELETE CASCADE,
  usuario text NOT NULL,
  senha_hash text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contas_usuario_uq ON contas (usuario);

CREATE TABLE sessoes (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL,
  cliente_id uuid NOT NULL REFERENCES cadastros(id) ON DELETE CASCADE,
  expira_em timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sessoes_token_hash_uq ON sessoes (token_hash);
