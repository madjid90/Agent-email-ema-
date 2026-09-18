export const name = "011_composio_poc";

/**
 * POC Composio (Outlook via Composio, lecture seule). Une ligne par utilisateur
 * EMA : uniquement des RÉFÉRENCES (identifiant du compte connecté Composio,
 * auth config, statut). Aucun access token ni refresh token Microsoft n'est
 * jamais stocké ici : Composio les détient.
 */
export const sql = String.raw`
CREATE TABLE IF NOT EXISTS composio_connections (
  user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  toolkit               TEXT NOT NULL DEFAULT 'outlook',
  connected_account_id  TEXT NOT NULL,
  auth_config_id        TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'INITIATED',
  status_reason         TEXT,
  account_email         TEXT,
  requested_scopes      TEXT NOT NULL DEFAULT '[]',
  last_error            TEXT,
  last_checked_at       TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_composio_connections_account ON composio_connections(connected_account_id);
`;
