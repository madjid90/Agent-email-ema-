import type { Db } from "../connection";
import { getDb } from "../connection";
import type { EmailAnalysisRow } from "../types";
import { newId, nowIso } from "@/lib/ids";
import type { EmailAnalysis } from "@/agent/schemas";

export interface AnalysisExtras {
  model: string | null;
  matchedRules?: string[];
  forwardTo?: string | null;
}

export function insertAnalysis(emailId: string, analysis: EmailAnalysis, extras: AnalysisExtras, db: Db = getDb()): EmailAnalysisRow {
  const id = newId("ana");
  db.prepare(
    `INSERT INTO email_analyses (id, email_id, category, urgency, summary, company_id, company_name, sender_json, requested_action, amount_value, amount_currency, amount_tax_mode, due_date, needs_reply, recommended_action, confidence, requires_approval, requires_human_review, reply_draft, reasoning_summary, injection_suspected, matched_rules, forward_to, raw_json, model, created_at)
     VALUES (@id, @email_id, @category, @urgency, @summary, @company_id, @company_name, @sender_json, @requested_action, @amount_value, @amount_currency, NULL, @due_date, @needs_reply, @recommended_action, @confidence, @requires_human_review, @requires_human_review, @reply_draft, @reasoning_summary, @injection_suspected, @matched_rules, @forward_to, @raw_json, @model, @created_at)`,
  ).run({
    id,
    email_id: emailId,
    category: analysis.category,
    urgency: analysis.urgency,
    summary: analysis.summary,
    company_id: analysis.company_id,
    company_name: analysis.company_name,
    sender_json: JSON.stringify(analysis.sender),
    requested_action: analysis.requested_action,
    amount_value: analysis.amount,
    amount_currency: analysis.currency,
    due_date: analysis.due_date,
    needs_reply: analysis.needs_reply ? 1 : 0,
    recommended_action: analysis.recommended_action,
    confidence: analysis.confidence,
    requires_human_review: analysis.requires_human_review ? 1 : 0,
    reply_draft: analysis.reply_draft,
    reasoning_summary: analysis.reasoning_summary,
    injection_suspected: analysis.injection_suspected ? 1 : 0,
    matched_rules: JSON.stringify(extras.matchedRules ?? []),
    forward_to: extras.forwardTo ?? null,
    raw_json: JSON.stringify(analysis),
    model: extras.model,
    created_at: nowIso(),
  });
  return db.prepare("SELECT * FROM email_analyses WHERE id = ?").get(id) as EmailAnalysisRow;
}

export function getLatestAnalysis(emailId: string, db: Db = getDb()): EmailAnalysisRow | undefined {
  return db.prepare("SELECT * FROM email_analyses WHERE email_id = ? ORDER BY created_at DESC LIMIT 1").get(emailId) as EmailAnalysisRow | undefined;
}

export function listAnalysesForEmail(emailId: string, db: Db = getDb()): EmailAnalysisRow[] {
  return db.prepare("SELECT * FROM email_analyses WHERE email_id = ? ORDER BY created_at DESC").all(emailId) as EmailAnalysisRow[];
}

/** Dernières analyses du même expéditeur (contexte borné). */
export function listRecentAnalysesFromSender(senderEmail: string, excludeEmailId: string, limit = 3, db: Db = getDb()): (EmailAnalysisRow & { subject: string; received_at: string })[] {
  return db
    .prepare(
      `SELECT a.*, e.subject, e.received_at FROM email_analyses a
       JOIN emails e ON e.id = a.email_id
       WHERE lower(e.sender_email) = lower(?) AND a.email_id != ?
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(senderEmail, excludeEmailId, limit) as (EmailAnalysisRow & { subject: string; received_at: string })[];
}

export interface EmailWithAnalysis {
  email_id: string;
  subject: string;
  sender_name: string | null;
  sender_email: string | null;
  received_at: string;
  status: string;
  category: string | null;
  urgency: string | null;
  summary: string | null;
  company_id: string | null;
  company_name: string | null;
  requested_action: string | null;
  recommended_action: string | null;
  confidence: number | null;
  needs_reply: number | null;
  requires_human_review: number | null;
  reply_draft: string | null;
  amount_value: number | null;
  amount_currency: string | null;
}

export function listEmailsWithAnalysis(opts: { limit?: number; since?: string } = {}, db: Db = getDb()): EmailWithAnalysis[] {
  const params: Record<string, unknown> = { limit: opts.limit ?? 100, since: opts.since ?? "" };
  return db
    .prepare(
      `SELECT e.id AS email_id, e.subject, e.sender_name, e.sender_email, e.received_at, e.status,
              a.category, a.urgency, a.summary, a.company_id, a.company_name, a.requested_action, a.recommended_action, a.confidence,
              a.needs_reply, a.requires_human_review, a.reply_draft, a.amount_value, a.amount_currency
       FROM emails e
       LEFT JOIN email_analyses a ON a.id = (
         SELECT id FROM email_analyses WHERE email_id = e.id ORDER BY created_at DESC LIMIT 1
       )
       WHERE e.direction = 'inbound' AND e.status != 'CONTEXT' AND (@since = '' OR e.received_at >= @since)
       ORDER BY e.received_at DESC LIMIT @limit`,
    )
    .all(params) as EmailWithAnalysis[];
}

export interface AnalysisStats {
  analyzed: number;
  urgent: number;
  needsReply: number;
  humanReview: number;
  invoices: number;
  quotes: number;
  failed: number;
}

/** Compteurs du jour (dernière analyse par email, emails reçus depuis `since`). */
export function analysisStats(since: string, db: Db = getDb()): AnalysisStats {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) AS analyzed,
         SUM(CASE WHEN a.urgency IN ('HIGH','CRITICAL') OR a.category = 'URGENT' THEN 1 ELSE 0 END) AS urgent,
         SUM(CASE WHEN a.needs_reply = 1 THEN 1 ELSE 0 END) AS needs_reply,
         SUM(CASE WHEN a.requires_human_review = 1 THEN 1 ELSE 0 END) AS human_review,
         SUM(CASE WHEN a.category = 'INVOICE' THEN 1 ELSE 0 END) AS invoices,
         SUM(CASE WHEN a.category IN ('QUOTE','DOCUMENT_TO_SIGN') THEN 1 ELSE 0 END) AS quotes,
         SUM(CASE WHEN e.status = 'ANALYSIS_FAILED' THEN 1 ELSE 0 END) AS failed
       FROM emails e
       LEFT JOIN email_analyses a ON a.id = (SELECT id FROM email_analyses WHERE email_id = e.id ORDER BY created_at DESC LIMIT 1)
       WHERE e.direction = 'inbound' AND e.status != 'CONTEXT' AND e.received_at >= ?`,
    )
    .get(since) as Record<string, number | null>;
  return {
    analyzed: row.analyzed ?? 0,
    urgent: row.urgent ?? 0,
    needsReply: row.needs_reply ?? 0,
    humanReview: row.human_review ?? 0,
    invoices: row.invoices ?? 0,
    quotes: row.quotes ?? 0,
    failed: row.failed ?? 0,
  };
}
