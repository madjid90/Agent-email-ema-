export const name = "008_followups";

/**
 * Phase 7 — Relances intelligentes.
 * La table scheduled_followups est reconstruite : la contrainte CHECK d'origine
 * n'acceptait que 6 statuts et la machine d'état en compte davantage (les
 * statuts sont désormais typés en TypeScript, comme pour emails/email_analyses).
 * Colonnes ajoutées : type de suivi, ancrage `watch_after`, société, document,
 * auteur, dernière vérification, action générée, suivi des notifications.
 * Les données existantes sont conservées (COMPLETED → SENT).
 */
export const sql = String.raw`
CREATE TABLE scheduled_followups_new (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL DEFAULT 'EXTERNAL_FOLLOWUP',
  thread_id           TEXT NOT NULL,
  email_id            TEXT REFERENCES emails(id) ON DELETE SET NULL,
  recipient           TEXT,
  company_id          TEXT,
  document_id         TEXT,
  title               TEXT,
  reason              TEXT NOT NULL DEFAULT '',
  execute_at          TEXT NOT NULL,
  watch_after         TEXT,
  status              TEXT NOT NULL DEFAULT 'SCHEDULED',
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 2,
  action_id           TEXT REFERENCES actions(id) ON DELETE SET NULL,
  generated_action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
  last_reply_email_id TEXT,
  requires_human_review INTEGER NOT NULL DEFAULT 0,
  notification_pending INTEGER NOT NULL DEFAULT 0,
  notify_attempts     INTEGER NOT NULL DEFAULT 0,
  notified_at         TEXT,
  last_checked_at     TEXT,
  last_error          TEXT,
  cancellation_reason TEXT,
  created_by          TEXT NOT NULL DEFAULT 'user',
  created_at          TEXT NOT NULL,
  updated_at          TEXT,
  completed_at        TEXT,
  cancelled_at        TEXT
);

INSERT INTO scheduled_followups_new (id, kind, thread_id, email_id, recipient, reason, execute_at, watch_after, status, attempts, max_attempts, action_id, created_by, created_at, completed_at, cancelled_at)
SELECT id, 'EXTERNAL_FOLLOWUP', thread_id, email_id, recipient, reason, execute_at, created_at,
       CASE status WHEN 'COMPLETED' THEN 'SENT' ELSE status END,
       attempts, max_attempts, action_id, 'user', created_at, completed_at, cancelled_at
FROM scheduled_followups;

DROP TABLE scheduled_followups;
ALTER TABLE scheduled_followups_new RENAME TO scheduled_followups;

CREATE INDEX IF NOT EXISTS idx_followups_due ON scheduled_followups(status, execute_at);
CREATE INDEX IF NOT EXISTS idx_followups_thread ON scheduled_followups(thread_id);
CREATE INDEX IF NOT EXISTS idx_followups_action ON scheduled_followups(generated_action_id);
`;
