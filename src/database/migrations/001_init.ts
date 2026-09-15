export const name = "001_init";

export const sql = String.raw`
-- EMA — schéma initial (phase 0)

CREATE TABLE IF NOT EXISTS emails (
  id              TEXT PRIMARY KEY,
  graph_id        TEXT NOT NULL UNIQUE,
  thread_id       TEXT,
  direction       TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  sender_name     TEXT,
  sender_email    TEXT,
  to_recipients   TEXT NOT NULL DEFAULT '[]',
  subject         TEXT NOT NULL DEFAULT '',
  body_preview    TEXT NOT NULL DEFAULT '',
  body_text       TEXT,
  received_at     TEXT NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ANALYZED','ACTION_PROPOSED','PROCESSED','IGNORED','ERROR')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);

CREATE TABLE IF NOT EXISTS email_analyses (
  id                 TEXT PRIMARY KEY,
  email_id           TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  category           TEXT NOT NULL,
  urgency            TEXT NOT NULL CHECK (urgency IN ('low','medium','high','critical')),
  summary            TEXT NOT NULL,
  company_id         TEXT,
  sender_json        TEXT NOT NULL DEFAULT '{}',
  requested_action   TEXT,
  amount_value       REAL,
  amount_currency    TEXT,
  amount_tax_mode    TEXT,
  due_date           TEXT,
  recommended_action TEXT NOT NULL,
  confidence         REAL NOT NULL,
  requires_approval  INTEGER NOT NULL DEFAULT 1,
  raw_json           TEXT NOT NULL,
  model              TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_email ON email_analyses(email_id);

CREATE TABLE IF NOT EXISTS actions (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  source_email_id   TEXT REFERENCES emails(id) ON DELETE SET NULL,
  company_id        TEXT,
  document_id       TEXT,
  payload           TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL CHECK (status IN ('PROPOSED','WAITING_APPROVAL','APPROVED','EXECUTING','COMPLETED','REJECTED','FAILED')),
  risk_level        TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  requires_approval INTEGER NOT NULL DEFAULT 1,
  title             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  approved_at       TEXT,
  executed_at       TEXT,
  completed_at      TEXT,
  error             TEXT,
  result            TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_email ON actions(source_email_id);
CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(created_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id                  TEXT PRIMARY KEY,
  action_id           TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('whatsapp','ui')),
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','MODIFIED','EXPIRED')),
  summary             TEXT NOT NULL,
  proposed_reply      TEXT,
  external_message_id TEXT,
  decided_at          TEXT,
  decided_by          TEXT,
  comment             TEXT,
  expires_at          TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_action ON approvals(action_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS scheduled_followups (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  email_id      TEXT REFERENCES emails(id) ON DELETE SET NULL,
  recipient     TEXT,
  reason        TEXT NOT NULL DEFAULT '',
  execute_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','CHECKING','WAITING_APPROVAL','COMPLETED','CANCELLED','FAILED')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  action_id     TEXT REFERENCES actions(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  cancelled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON scheduled_followups(status, execute_at);
CREATE INDEX IF NOT EXISTS idx_followups_thread ON scheduled_followups(thread_id);

CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  email_id       TEXT REFERENCES emails(id) ON DELETE SET NULL,
  attachment_id  TEXT,
  name           TEXT NOT NULL,
  mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
  size           INTEGER NOT NULL DEFAULT 0,
  category       TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('invoice','quote','signed','other')),
  company_id     TEXT,
  original_path  TEXT NOT NULL,
  signed_path    TEXT,
  extracted_text TEXT,
  extracted_data TEXT,
  status         TEXT NOT NULL DEFAULT 'received',
  created_at     TEXT NOT NULL,
  signed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_email ON documents(email_id);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);

CREATE TABLE IF NOT EXISTS history (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  message     TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'ema' CHECK (actor IN ('ema','user','worker','whatsapp','system')),
  email_id    TEXT,
  action_id   TEXT,
  document_id TEXT,
  followup_id TEXT,
  approval_id TEXT,
  details     TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_at ON history(at DESC);
CREATE INDEX IF NOT EXISTS idx_history_action ON history(action_id);
CREATE INDEX IF NOT EXISTS idx_history_email ON history(email_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider      TEXT PRIMARY KEY,
  account_email TEXT,
  encrypted     TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '',
  expires_at    TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_locks (
  name         TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  locked_until TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content    TEXT NOT NULL,
  tool_calls TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
`;
