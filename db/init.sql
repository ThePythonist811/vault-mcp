-- Schema for vault-mcp. Mirrors src/lib/db/schema.ts; runs once on first DB start.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_clients (
  id text PRIMARY KEY,
  client_secret_hash text,
  redirect_uris text[] NOT NULL,
  name text,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_auth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_auth_codes_expires_at_idx ON oauth_auth_codes (expires_at);

CREATE TABLE oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash text NOT NULL UNIQUE,
  refresh_token_hash text,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_refresh_token_hash_idx ON oauth_tokens (refresh_token_hash);
CREATE INDEX oauth_tokens_user_id_idx ON oauth_tokens (user_id);

-- Write proposals from Claude. Nothing touches the vault until a human approves.
CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('create', 'replace', 'edit', 'append')),
  path text NOT NULL,
  base_hash text,            -- sha256 of the file when proposed; NULL = file must not exist
  new_content text NOT NULL,
  diff text NOT NULL,
  reason text NOT NULL,
  client_id text NOT NULL,
  client_name text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected', 'expired', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE INDEX proposals_status_idx ON proposals (status, created_at DESC);

-- Who did what, when. Never stores note contents.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,        -- 'client:<id>' for MCP calls, 'user:<clerk id>' for UI actions
  action text NOT NULL,
  path text,
  detail text,
  ok boolean NOT NULL
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
