/** Types des lignes SQLite (miroir du schéma 001_init). */

export type EmailStatus = "NEW" | "ANALYZED" | "ACTION_PROPOSED" | "PROCESSED" | "IGNORED" | "ERROR";
export type EmailDirection = "inbound" | "outbound";

export interface EmailRow {
  id: string;
  graph_id: string;
  thread_id: string | null;
  direction: EmailDirection;
  sender_name: string | null;
  sender_email: string | null;
  to_recipients: string; // JSON string[]
  subject: string;
  body_preview: string;
  body_text: string | null;
  received_at: string;
  has_attachments: number;
  status: EmailStatus;
  created_at: string;
  updated_at: string;
}

export type Urgency = "low" | "medium" | "high" | "critical";

export interface EmailAnalysisRow {
  id: string;
  email_id: string;
  category: string;
  urgency: Urgency;
  summary: string;
  company_id: string | null;
  sender_json: string;
  requested_action: string | null;
  amount_value: number | null;
  amount_currency: string | null;
  amount_tax_mode: string | null;
  due_date: string | null;
  recommended_action: string;
  confidence: number;
  requires_approval: number;
  raw_json: string;
  model: string | null;
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
  signed_path: string | null;
  extracted_text: string | null;
  extracted_data: string | null;
  status: string;
  created_at: string;
  signed_at: string | null;
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

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: string | null;
  created_at: string;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
