export const name = "009_hardening";

/**
 * Phase 8A — durcissement production :
 * - actions.error_code : distingue un échec clair d'un envoi au résultat ambigu
 *   (DELIVERY_AMBIGUOUS) pour interdire tout renvoi automatique.
 * - webhook_events : véritable cycle de traitement (RECEIVED → PROCESSING →
 *   PROCESSED / FAILED) avec verrou et compteur, récupérable après un crash.
 * - rate_limits : limitation des tentatives de connexion, persistée (survit à un
 *   redémarrage), sans infrastructure externe.
 */
export const sql = String.raw`
ALTER TABLE actions ADD COLUMN error_code TEXT;

ALTER TABLE webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'PROCESSED';
ALTER TABLE webhook_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE webhook_events ADD COLUMN started_at TEXT;
ALTER TABLE webhook_events ADD COLUMN processed_at TEXT;
ALTER TABLE webhook_events ADD COLUMN locked_until TEXT;
ALTER TABLE webhook_events ADD COLUMN last_error TEXT;
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events(status, locked_until);

CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT PRIMARY KEY,
  hits          INTEGER NOT NULL DEFAULT 0,
  window_start  TEXT NOT NULL,
  blocked_until TEXT,
  updated_at    TEXT NOT NULL
);
`;
