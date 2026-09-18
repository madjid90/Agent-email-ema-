import type { Db } from "../connection";
import { getDb } from "../connection";
import type { HistoryActor, HistoryRow } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface HistoryEvent {
  eventType: string;
  message: string;
  actor?: HistoryActor;
  emailId?: string | null;
  actionId?: string | null;
  documentId?: string | null;
  followupId?: string | null;
  approvalId?: string | null;
  details?: unknown;
  /** Utilisateur concerné (audit par compte). */
  userId?: string | null;
}

export function logHistory(event: HistoryEvent, db: Db = getDb()): HistoryRow {
  const id = newId("his");
  db.prepare(
    `INSERT INTO history (id, at, event_type, message, actor, email_id, action_id, document_id, followup_id, approval_id, details, user_id)
     VALUES (@id, @at, @event_type, @message, @actor, @email_id, @action_id, @document_id, @followup_id, @approval_id, @details, @user_id)`,
  ).run({
    id,
    user_id: event.userId ?? null,
    at: nowIso(),
    event_type: event.eventType,
    message: event.message,
    actor: event.actor ?? "ema",
    email_id: event.emailId ?? null,
    action_id: event.actionId ?? null,
    document_id: event.documentId ?? null,
    followup_id: event.followupId ?? null,
    approval_id: event.approvalId ?? null,
    details: event.details === undefined ? null : JSON.stringify(event.details),
  });
  return db.prepare("SELECT * FROM history WHERE id = ?").get(id) as HistoryRow;
}

export function listHistory(opts: { limit?: number; since?: string; emailId?: string; actionId?: string; userId?: string } = {}, db: Db = getDb()): HistoryRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 200 };
  if (opts.userId) {
    clauses.push("user_id = @user_id");
    params.user_id = opts.userId;
  }
  if (opts.since) {
    clauses.push("at >= @since");
    params.since = opts.since;
  }
  if (opts.emailId) {
    clauses.push("email_id = @email_id");
    params.email_id = opts.emailId;
  }
  if (opts.actionId) {
    clauses.push("action_id = @action_id");
    params.action_id = opts.actionId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM history ${where} ORDER BY at DESC LIMIT @limit`).all(params) as HistoryRow[];
}
