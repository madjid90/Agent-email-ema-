export const name = "003_analysis";

/**
 * Phase 2 — Analyse Claude :
 * - emails : statuts ANALYZING / ANALYSIS_FAILED. La contrainte CHECK sur `status`
 *   est retirée (les statuts sont validés côté TypeScript, `EmailStatus`), pour ne
 *   plus reconstruire la table à chaque nouveau statut.
 * - email_analyses : reconstruite (catégories/urgences en majuscules, sans CHECK) avec
 *   needs_reply, requires_human_review, reply_draft, reasoning_summary, company_name,
 *   injection_suspected, matched_rules, forward_to.
 * - llm_runs : journal des appels Claude (usage, durée, erreur), sans contenu.
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
  status              TEXT NOT NULL DEFAULT 'NEW',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
INSERT INTO emails_new SELECT id, graph_id, thread_id, internet_message_id, direction, sender_name, sender_email, to_recipients, cc_recipients, subject, body_preview, body_text, received_at, sent_at, has_attachments, is_read, web_link, folder, status, created_at, updated_at FROM emails;
DROP TABLE emails;
ALTER TABLE emails_new RENAME TO emails;
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_internet_id ON emails(internet_message_id);

CREATE TABLE email_analyses_new (
  id                    TEXT PRIMARY KEY,
  email_id              TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  category              TEXT NOT NULL,
  urgency               TEXT NOT NULL,
  summary               TEXT NOT NULL,
  company_id            TEXT,
  company_name          TEXT,
  sender_json           TEXT NOT NULL DEFAULT '{}',
  requested_action      TEXT,
  amount_value          REAL,
  amount_currency       TEXT,
  amount_tax_mode       TEXT,
  due_date              TEXT,
  needs_reply           INTEGER NOT NULL DEFAULT 0,
  recommended_action    TEXT NOT NULL,
  confidence            REAL NOT NULL,
  requires_approval     INTEGER NOT NULL DEFAULT 1,
  requires_human_review INTEGER NOT NULL DEFAULT 1,
  reply_draft           TEXT,
  reasoning_summary     TEXT,
  injection_suspected   INTEGER NOT NULL DEFAULT 0,
  matched_rules         TEXT NOT NULL DEFAULT '[]',
  forward_to            TEXT,
  raw_json              TEXT NOT NULL,
  model                 TEXT,
  created_at            TEXT NOT NULL
);
INSERT INTO email_analyses_new (id, email_id, category, urgency, summary, company_id, sender_json, requested_action, amount_value, amount_currency, amount_tax_mode, due_date, recommended_action, confidence, requires_approval, requires_human_review, raw_json, model, created_at)
  SELECT id, email_id, upper(category), upper(urgency), summary, company_id, sender_json, requested_action, amount_value, amount_currency, amount_tax_mode, due_date, recommended_action, confidence, requires_approval, requires_approval, raw_json, model, created_at FROM email_analyses;
DROP TABLE email_analyses;
ALTER TABLE email_analyses_new RENAME TO email_analyses;
CREATE INDEX IF NOT EXISTS idx_analyses_email ON email_analyses(email_id);

CREATE TABLE IF NOT EXISTS llm_runs (
  id                    TEXT PRIMARY KEY,
  email_id              TEXT,
  operation             TEXT NOT NULL,
  model                 TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('ok','error')),
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  duration_ms           INTEGER NOT NULL,
  stop_reason           TEXT,
  error                 TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_runs_email ON llm_runs(email_id);
CREATE INDEX IF NOT EXISTS idx_llm_runs_created ON llm_runs(created_at DESC);
`;
