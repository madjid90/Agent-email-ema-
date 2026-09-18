export const name = "010_users";

/**
 * Comptes utilisateurs et connexions par utilisateur (assistant multi-dirigeants).
 *
 * - users : identité EMA (email + mot de passe), numéro WhatsApp E.164 vérifié.
 *   Un numéro actif n'appartient qu'à un seul compte.
 * - connections : tokens Microsoft chiffrés PAR utilisateur (remplace la ligne
 *   unique d'oauth_tokens). Les anciens tokens sont conservés sans utilisateur
 *   (`user_id NULL`) et adoptés par le premier compte créé.
 * - user_id sur les tables métier : chaque email, document, action, relance,
 *   message de conversation et événement d'historique appartient à un
 *   utilisateur. Les lignes antérieures restent NULL (instance mono-utilisateur).
 */
export const sql = String.raw`
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT,
  email             TEXT NOT NULL COLLATE NOCASE,
  name              TEXT,
  password_hash     TEXT,
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner','user')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  phone_number      TEXT,
  phone_verified    INTEGER NOT NULL DEFAULT 0,
  whatsapp_enabled  INTEGER NOT NULL DEFAULT 0,
  verified_at       TEXT,
  last_login_at     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_active ON users(phone_number) WHERE phone_number IS NOT NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS connections (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT REFERENCES users(id) ON DELETE CASCADE,
  organization_id         TEXT,
  provider                TEXT NOT NULL,
  encrypted               TEXT NOT NULL,
  scopes                  TEXT NOT NULL DEFAULT '',
  expires_at              TEXT,
  provider_account_email  TEXT,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_error              TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_user_provider ON connections(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_connections_provider ON connections(provider, status);

INSERT INTO connections (id, user_id, provider, encrypted, scopes, expires_at, provider_account_email, status, created_at, updated_at)
  SELECT 'con_legacy_' || provider, NULL, provider, encrypted, scopes, expires_at, account_email, 'active', updated_at, updated_at FROM oauth_tokens;
DROP TABLE oauth_tokens;

ALTER TABLE emails ADD COLUMN user_id TEXT;
ALTER TABLE documents ADD COLUMN user_id TEXT;
ALTER TABLE actions ADD COLUMN user_id TEXT;
ALTER TABLE scheduled_followups ADD COLUMN user_id TEXT;
ALTER TABLE chat_messages ADD COLUMN user_id TEXT;
ALTER TABLE history ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_user ON actions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_followups_user ON scheduled_followups(user_id, execute_at);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, at DESC);
`;
