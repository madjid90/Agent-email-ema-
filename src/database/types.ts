/** Types des lignes SQLite (miroir du schéma 001_init). */

/**
 * Cycle de vie d'un email entrant :
 * NEW → ANALYZING → ANALYZED | ANALYSIS_FAILED → ACTION_PROPOSED → PROCESSED.
 * CONTEXT = importé pour le contexte (thread, recherche), jamais analysé comme nouvel email.
 * Validé côté TypeScript (pas de CHECK SQL depuis 003_analysis).
 */
export type EmailStatus = "NEW" | "ANALYZING" | "ANALYZED" | "ANALYSIS_FAILED" | "ACTION_PROPOSED" | "PROCESSED" | "IGNORED" | "ERROR" | "CONTEXT";
export const EMAIL_STATUSES: readonly EmailStatus[] = ["NEW", "ANALYZING", "ANALYZED", "ANALYSIS_FAILED", "ACTION_PROPOSED", "PROCESSED", "IGNORED", "ERROR", "CONTEXT"];
export type EmailDirection = "inbound" | "outbound";

export interface EmailRow {
  id: string;
  graph_id: string;
  thread_id: string | null;
  internet_message_id: string | null;
  direction: EmailDirection;
  sender_name: string | null;
  sender_email: string | null;
  to_recipients: string; // JSON string[]
  cc_recipients: string; // JSON string[]
  subject: string;
  body_preview: string;
  body_text: string | null;
  received_at: string;
  sent_at: string | null;
  has_attachments: number;
  is_read: number;
  web_link: string | null;
  folder: string | null;
  status: EmailStatus;
  created_at: string;
  updated_at: string;
}

export type Urgency = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export interface EmailAnalysisRow {
  id: string;
  email_id: string;
  category: string;
  urgency: Urgency;
  summary: string;
  company_id: string | null;
  company_name: string | null;
  sender_json: string;
  requested_action: string | null;
  amount_value: number | null;
  amount_currency: string | null;
  amount_tax_mode: string | null;
  due_date: string | null;
  needs_reply: number;
  recommended_action: string;
  confidence: number;
  /** Colonne historique (phase 0) : toujours égale à requires_human_review. */
  requires_approval: number;
  requires_human_review: number;
  reply_draft: string | null;
  reasoning_summary: string | null;
  injection_suspected: number;
  matched_rules: string; // JSON string[]
  forward_to: string | null;
  raw_json: string;
  model: string | null;
  created_at: string;
}

export interface LlmRunRow {
  id: string;
  email_id: string | null;
  operation: string;
  model: string;
  status: "ok" | "error";
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  duration_ms: number;
  stop_reason: string | null;
  error: string | null;
  created_at: string;
}

export type ActionStatus = "PROPOSED" | "WAITING_APPROVAL" | "APPROVED" | "EXECUTING" | "COMPLETED" | "REJECTED" | "FAILED";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ActionRow {
  id: string;
  type: string;
  source_email_id: string | null;
  company_id: string | null;
  document_id: string | null;
  payload: string; // JSON
  status: ActionStatus;
  risk_level: RiskLevel;
  requires_approval: number;
  title: string;
  created_at: string;
  approved_at: string | null;
  executed_at: string | null;
  completed_at: string | null;
  error: string | null;
  result: string | null; // JSON
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "MODIFIED" | "EXPIRED";
export type ApprovalChannel = "whatsapp" | "ui";

export interface ApprovalRow {
  id: string;
  action_id: string;
  channel: ApprovalChannel;
  status: ApprovalStatus;
  summary: string;
  proposed_reply: string | null;
  external_message_id: string | null;
  decided_at: string | null;
  decided_by: string | null;
  comment: string | null;
  expires_at: string;
  created_at: string;
  notify_attempts: number;
  sent_at: string | null;
  last_notify_error: string | null;
}

export interface WebhookEventRow {
  id: string;
  provider: string;
  external_id: string;
  event_type: string;
  sender: string | null;
  received_at: string;
  result: string | null;
}

export type FollowupStatus = "SCHEDULED" | "CHECKING" | "WAITING_APPROVAL" | "COMPLETED" | "CANCELLED" | "FAILED";

export interface FollowupRow {
  id: string;
  thread_id: string;
  email_id: string | null;
  recipient: string | null;
  reason: string;
  execute_at: string;
  status: FollowupStatus;
  attempts: number;
  max_attempts: number;
  action_id: string | null;
  created_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

export type DocumentCategory = "invoice" | "quote" | "signed" | "other";
export type DocumentTextStatus = "pending" | "extracted" | "no_text" | "unsupported" | "error";

export interface DocumentRow {
  id: string;
  email_id: string | null;
  attachment_id: string | null;
  name: string;
  mime_type: string;
  size: number;
  category: DocumentCategory;
  company_id: string | null;
  original_path: string;
  stored_name: string | null;
  sha256: string | null;
  signed_path: string | null;
  extracted_text: string | null;
  extracted_data: string | null;
  status: string;
  created_at: string;
  signed_at: string | null;
  doc_type: string | null;
  text_status: DocumentTextStatus;
  text_pages: number | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  amount_excl_tax: number | null;
  amount_incl_tax: number | null;
  currency: string | null;
  doc_confidence: number | null;
  requires_human_review: number;
  possible_duplicate: number;
  duplicate_of: string; // JSON string[]
  bank_details_change: number;
  analyzed_at: string | null;
  analysis_error: string | null;
  quote_number: string | null;
  valid_until: string | null;
  subject: string | null;
  /** Copie signée : identifiant du document original. */
  parent_document_id: string | null;
  /** Original : identifiant de la copie signée créée. */
  signed_document_id: string | null;
  signed_action_id: string | null;
  signed_approval_id: string | null;
  sent_at: string | null;
}

export type HistoryActor = "ema" | "user" | "worker" | "whatsapp" | "system";

export interface HistoryRow {
  id: string;
  at: string;
  event_type: string;
  message: string;
  actor: HistoryActor;
  email_id: string | null;
  action_id: string | null;
  document_id: string | null;
  followup_id: string | null;
  approval_id: string | null;
  details: string | null;
}

export interface OAuthTokenRow {
  provider: string;
  account_email: string | null;
  encrypted: string;
  scopes: string;
  expires_at: string | null;
  updated_at: string;
}

export type ChatChannel = "WEB" | "WHATSAPP";

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: string | null;
  created_at: string;
  /** Canal d'origine : interface web ou WhatsApp (phase 6). */
  channel: ChatChannel;
  /** Identifiant Meta du message entrant (dédoublonnage, jamais le numéro en clair). */
  external_id: string | null;
  /** Expéditeur masqué (ex. « 3361…78 ») : jamais le numéro complet. */
  sender: string | null;
  /** Références numérotées présentées à l'utilisateur (JSON) — contexte multi-tours. */
  refs: string | null;
  email_id: string | null;
  document_id: string | null;
  action_id: string | null;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
