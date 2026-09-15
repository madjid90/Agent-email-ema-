export const name = "004_whatsapp";

/**
 * Phase 3 — WhatsApp / validation :
 * - approvals : suivi de l'envoi de la notification (tentatives, date, dernière erreur, numéro décideur).
 * - webhook_events : dédoublonnage des événements entrants (identifiant Meta unique).
 */
export const sql = String.raw`
ALTER TABLE approvals ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN sent_at TEXT;
ALTER TABLE approvals ADD COLUMN last_notify_error TEXT;

CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  sender      TEXT,
  received_at TEXT NOT NULL,
  result      TEXT,
  UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at DESC);
`;
