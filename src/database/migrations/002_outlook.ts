export const name = "002_outlook";

/**
 * Phase 1 — Outlook :
 * - emails : identifiant Internet, destinataires en copie, date d'envoi, lu/non lu,
 *   lien web, dossier ; nouveau statut CONTEXT (message importé pour le contexte
 *   d'un thread ou d'une recherche, jamais traité comme un nouvel email).
 * - documents : nom de stockage, empreinte SHA-256, unicité (email, pièce jointe).
 *
 * SQLite ne modifie pas une contrainte CHECK : la table emails est reconstruite
 * (procédure officielle en 12 étapes, clés étrangères désactivées par runMigrations).
 */
export const sql = String.raw`
CREATE TABLE emails_new (
  id                  TEXT PRIMARY KEY,
  graph_id            TEXT NOT NULL UNIQUE,
  thread_id           TEXT,
  internet_message_id TEXT,
  direction           TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  sender_name         TEXT,
  sender_email        TEXT,
  to_recipients       TEXT NOT NULL DEFAULT '[]',
  cc_recipients       TEXT NOT NULL DEFAULT '[]',
  subject             TEXT NOT NULL DEFAULT '',
  body_preview        TEXT NOT NULL DEFAULT '',
  body_text           TEXT,
  received_at         TEXT NOT NULL,
  sent_at             TEXT,
  has_attachments     INTEGER NOT NULL DEFAULT 0,
  is_read             INTEGER NOT NULL DEFAULT 0,
  web_link            TEXT,
  folder              TEXT,
  status              TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ANALYZED','ACTION_PROPOSED','PROCESSED','IGNORED','ERROR','CONTEXT')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
INSERT INTO emails_new (id, graph_id, thread_id, direction, sender_name, sender_email, to_recipients, subject, body_preview, body_text, received_at, has_attachments, status, created_at, updated_at)
  SELECT id, graph_id, thread_id, direction, sender_name, sender_email, to_recipients, subject, body_preview, body_text, received_at, has_attachments, status, created_at, updated_at FROM emails;
DROP TABLE emails;
ALTER TABLE emails_new RENAME TO emails;
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_internet_id ON emails(internet_message_id);

ALTER TABLE documents ADD COLUMN stored_name TEXT;
ALTER TABLE documents ADD COLUMN sha256 TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_email_attachment ON documents(email_id, attachment_id) WHERE attachment_id IS NOT NULL;
`;
