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
  /** Propriétaire de la boîte dont provient l'email (NULL : données antérieures à 010_users). */
  user_id: string | null;
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
  user_id: string | null;
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
  /** Code stable du dernier échec (`DELIVERY_AMBIGUOUS` interdit tout renvoi automatique). */
  error_code: string | null;
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

/** Cycle de traitement d'un événement entrant (phase 8A). */
export type WebhookStatus = "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED";

export interface WebhookEventRow {
  id: string;
  provider: string;
  external_id: string;
  event_type: string;
  sender: string | null;
  received_at: string;
  result: string | null;
  status: WebhookStatus;
  attempts: number;
  started_at: string | null;
  processed_at: string | null;
  locked_until: string | null;
  last_error: string | null;
}

/**
 * Machine d'état d'une relance (phase 7). `SCHEDULED` et `CHECK_FAILED` sont les
 * seuls statuts repris par le worker ; `SENT`, `RESPONSE_RECEIVED`, `CANCELLED`,
 * `SUPERSEDED`, `MAX_ATTEMPTS_REACHED` et `DONE` sont terminaux.
 */
export type FollowupStatus =
  | "SCHEDULED"
  | "CHECKING"
  | "CHECK_FAILED"
  | "RESPONSE_RECEIVED"
  | "REVIEW_REQUIRED"
  | "WAITING_APPROVAL"
  | "REMINDED"
  | "SENT"
  | "CANCELLED"
  | "SUPERSEDED"
  | "MAX_ATTEMPTS_REACHED"
  | "FAILED"
  | "DONE";

export type FollowupKind = "EXTERNAL_FOLLOWUP" | "INTERNAL_REMINDER";

/** Statuts qui n'entraîneront plus jamais d'envoi. */
export const TERMINAL_FOLLOWUP_STATUSES: FollowupStatus[] = ["RESPONSE_RECEIVED", "SENT", "CANCELLED", "SUPERSEDED", "MAX_ATTEMPTS_REACHED", "DONE"];

export interface FollowupRow {
  id: string;
  user_id: string | null;
  kind: FollowupKind;
  thread_id: string;
  email_id: string | null;
  recipient: string | null;
  company_id: string | null;
  document_id: string | null;
  title: string | null;
  reason: string;
  execute_at: string;
  /** Ancrage : seuls les messages postérieurs comptent comme réponse. */
  watch_after: string | null;
  status: FollowupStatus;
  attempts: number;
  max_attempts: number;
  /** Action à l'origine de la relance (ex. demande de règlement). */
  action_id: string | null;
  /** Action `reply_email` créée à l'échéance. */
  generated_action_id: string | null;
  last_reply_email_id: string | null;
  requires_human_review: number;
  notification_pending: number;
  notify_attempts: number;
  notified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  cancellation_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export type DocumentCategory = "invoice" | "quote" | "signed" | "other";
export type DocumentTextStatus = "pending" | "extracted" | "no_text" | "unsupported" | "error";

export interface DocumentRow {
  id: string;
  user_id: string | null;
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
  user_id: string | null;
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

export type UserRole = "owner" | "user";
export type UserStatus = "active" | "disabled";

/** Compte EMA : identité web (email + mot de passe) et identité WhatsApp (numéro E.164 vérifié). */
export interface UserRow {
  id: string;
  organization_id: string | null;
  email: string;
  name: string | null;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
  phone_number: string | null;
  phone_verified: number;
  whatsapp_enabled: number;
  verified_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ConnectionStatus = "active" | "revoked";

/** Connexion à un fournisseur externe (Microsoft) appartenant à UN utilisateur. Le blob est chiffré. */
export interface ConnectionRow {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  provider: string;
  encrypted: string;
  scopes: string;
  expires_at: string | null;
  provider_account_email: string | null;
  status: ConnectionStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type ChatChannel = "WEB" | "WHATSAPP";

export interface ChatMessageRow {
  id: string;
  user_id: string | null;
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
