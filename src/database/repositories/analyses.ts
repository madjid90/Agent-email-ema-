import type { Db } from "../connection";
import { getDb } from "../connection";
import type { EmailAnalysisRow } from "../types";
import { newId, nowIso } from "@/lib/ids";
import type { EmailAnalysis } from "@/agent/schemas";

export function insertAnalysis(emailId: string, analysis: EmailAnalysis, model: string | null, db: Db = getDb()): EmailAnalysisRow {
  const id = newId("ana");
  db.prepare(
    `INSERT INTO email_analyses (id, email_id, category, urgency, summary, company_id, sender_json, requested_action, amount_value, amount_currency, amount_tax_mode, due_date, recommended_action, confidence, requires_approval, raw_json, model, created_at)
     VALUES (@id, @email_id, @category, @urgency, @summary, @company_id, @sender_json, @requested_action, @amount_value, @amount_currency, @amount_tax_mode, @due_date, @recommended_action, @confidence, @requires_approval, @raw_json, @model, @created_at)`,
  ).run({
    id,
    email_id: emailId,
    category: analysis.category,
    urgency: analysis.urgency,
    summary: analysis.summary,
    company_id: analysis.company,
    sender_json: JSON.stringify(analysis.sender),
    requested_action: analysis.requested_action,
    amount_value: analysis.amount?.value ?? null,
    amount_currency: analysis.amount?.currency ?? null,
    amount_tax_mode: analysis.amount?.taxMode ?? null,
    due_date: analysis.due_date,
    recommended_action: analysis.recommended_action,
    confidence: analysis.confidence,
    requires_approval: analysis.requires_approval ? 1 : 0,
    raw_json: JSON.stringify(analysis),
    model,
    created_at: nowIso(),
  });
  return db.prepare("SELECT * FROM email_analyses WHERE id = ?").get(id) as EmailAnalysisRow;
}

export function getLatestAnalysis(emailId: string, db: Db = getDb()): EmailAnalysisRow | undefined {
  return db.prepare("SELECT * FROM email_analyses WHERE email_id = ? ORDER BY created_at DESC LIMIT 1").get(emailId) as
    | EmailAnalysisRow
    | undefined;
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
  recommended_action: string | null;
  confidence: number | null;
  amount_value: number | null;
  amount_currency: string | null;
}

export function listEmailsWithAnalysis(opts: { limit?: number; since?: string } = {}, db: Db = getDb()): EmailWithAnalysis[] {
  const params: Record<string, unknown> = { limit: opts.limit ?? 100, since: opts.since ?? "" };
  return db
    .prepare(
      `SELECT e.id AS email_id, e.subject, e.sender_name, e.sender_email, e.received_at, e.status,
              a.category, a.urgency, a.summary, a.company_id, a.recommended_action, a.confidence, a.amount_value, a.amount_currency
       FROM emails e
       LEFT JOIN email_analyses a ON a.id = (
         SELECT id FROM email_analyses WHERE email_id = e.id ORDER BY created_at DESC LIMIT 1
       )
       WHERE e.direction = 'inbound' AND (@since = '' OR e.received_at >= @since)
       ORDER BY e.received_at DESC LIMIT @limit`,
    )
    .all(params) as EmailWithAnalysis[];
}

export function countAnalysesByCategory(since: string, db: Db = getDb()): Record<string, number> {
  const rows = db
    .prepare("SELECT category, COUNT(*) AS n FROM email_analyses WHERE created_at >= ? GROUP BY category")
    .all(since) as { category: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.category, r.n]));
}
