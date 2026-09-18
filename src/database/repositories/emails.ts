import type { Db } from "../connection";
import { getDb } from "../connection";
import type { EmailRow, EmailStatus } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewEmail {
  /** Propriétaire de la boîte (toujours fourni par la synchronisation). */
  userId?: string | null;
  graphId: string;
  threadId?: string | null;
  internetMessageId?: string | null;
  direction?: "inbound" | "outbound";
  senderName?: string | null;
  senderEmail?: string | null;
  toRecipients?: string[];
  ccRecipients?: string[];
  subject: string;
  bodyPreview?: string;
  bodyText?: string | null;
  receivedAt: string;
  sentAt?: string | null;
  hasAttachments?: boolean;
  isRead?: boolean;
  webLink?: string | null;
  folder?: string | null;
  status?: EmailStatus;
}

export function insertEmail(input: NewEmail, db: Db = getDb()): EmailRow {
  const id = newId("eml");
  const now = nowIso();
  db.prepare(
    `INSERT INTO emails (id, user_id, graph_id, thread_id, internet_message_id, direction, sender_name, sender_email, to_recipients, cc_recipients, subject, body_preview, body_text, received_at, sent_at, has_attachments, is_read, web_link, folder, status, created_at, updated_at)
     VALUES (@id, @user_id, @graph_id, @thread_id, @internet_message_id, @direction, @sender_name, @sender_email, @to_recipients, @cc_recipients, @subject, @body_preview, @body_text, @received_at, @sent_at, @has_attachments, @is_read, @web_link, @folder, @status, @now, @now)`,
  ).run({
    id,
    user_id: input.userId ?? null,
    graph_id: input.graphId,
    thread_id: input.threadId ?? null,
    internet_message_id: input.internetMessageId ?? null,
    direction: input.direction ?? "inbound",
    sender_name: input.senderName ?? null,
    sender_email: input.senderEmail ?? null,
    to_recipients: JSON.stringify(input.toRecipients ?? []),
    cc_recipients: JSON.stringify(input.ccRecipients ?? []),
    subject: input.subject,
    body_preview: input.bodyPreview ?? "",
    body_text: input.bodyText ?? null,
    received_at: input.receivedAt,
    sent_at: input.sentAt ?? null,
    has_attachments: input.hasAttachments ? 1 : 0,
    is_read: input.isRead ? 1 : 0,
    web_link: input.webLink ?? null,
    folder: input.folder ?? null,
    status: input.status ?? "NEW",
    now,
  });
  return getEmail(id, db) as EmailRow;
}

export function getEmail(id: string, db: Db = getDb()): EmailRow | undefined {
  return db.prepare("SELECT * FROM emails WHERE id = ?").get(id) as EmailRow | undefined;
}

export function getEmailByGraphId(graphId: string, db: Db = getDb()): EmailRow | undefined {
  return db.prepare("SELECT * FROM emails WHERE graph_id = ?").get(graphId) as EmailRow | undefined;
}

export function getEmailByInternetMessageId(internetMessageId: string, db: Db = getDb()): EmailRow | undefined {
  return db.prepare("SELECT * FROM emails WHERE internet_message_id = ? LIMIT 1").get(internetMessageId) as EmailRow | undefined;
}

/** Filtre de propriétaire : `userId` fourni → uniquement les lignes de cet utilisateur. */
function ownerClause(userId: string | undefined, clauses: string[], params: Record<string, unknown>): void {
  if (userId) {
    clauses.push("user_id = @user_id");
    params.user_id = userId;
  }
}

export function listEmails(opts: { status?: EmailStatus; limit?: number; since?: string; userId?: string } = {}, db: Db = getDb()): EmailRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 50 };
  ownerClause(opts.userId, clauses, params);
  if (opts.status) {
    clauses.push("status = @status");
    params.status = opts.status;
  }
  if (opts.since) {
    clauses.push("received_at >= @since");
    params.since = opts.since;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM emails ${where} ORDER BY received_at DESC LIMIT @limit`).all(params) as EmailRow[];
}

export function listThread(threadId: string, db: Db = getDb(), userId?: string): EmailRow[] {
  if (userId) return db.prepare("SELECT * FROM emails WHERE thread_id = ? AND user_id = ? ORDER BY received_at ASC").all(threadId, userId) as EmailRow[];
  return db.prepare("SELECT * FROM emails WHERE thread_id = ? ORDER BY received_at ASC").all(threadId) as EmailRow[];
}

export function updateEmailStatus(id: string, status: EmailStatus, db: Db = getDb()): void {
  db.prepare("UPDATE emails SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
}

/** Transition conditionnelle (idempotence : un seul process analyse un email). */
export function transitionEmailStatus(id: string, from: EmailStatus[], to: EmailStatus, db: Db = getDb()): boolean {
  const params: Record<string, unknown> = { id, to, now: nowIso() };
  from.forEach((s, i) => (params[`f${i}`] = s));
  const res = db.prepare(`UPDATE emails SET status = @to, updated_at = @now WHERE id = @id AND status IN (${from.map((_, i) => `@f${i}`).join(",")})`).run(params);
  return res.changes === 1;
}

/** Emails entrants en attente d'analyse, du plus ancien au plus récent. */
export function listPendingAnalysis(limit = 5, db: Db = getDb()): EmailRow[] {
  return db.prepare("SELECT * FROM emails WHERE status = 'NEW' AND direction = 'inbound' ORDER BY received_at ASC LIMIT ?").all(limit) as EmailRow[];
}

/** Analyses bloquées (process interrompu) → ANALYSIS_FAILED, jamais relancées automatiquement. */
export function failStaleAnalyzing(olderThanIso: string, db: Db = getDb()): number {
  return db.prepare("UPDATE emails SET status = 'ANALYSIS_FAILED', updated_at = ? WHERE status = 'ANALYZING' AND updated_at < ?").run(nowIso(), olderThanIso).changes;
}

/** Met à jour les champs volatils d'un email déjà connu (lu/non lu, dossier). */
export function touchEmail(id: string, patch: { isRead?: boolean; folder?: string | null }, db: Db = getDb()): void {
  const sets: string[] = ["updated_at = @now"];
  const params: Record<string, unknown> = { id, now: nowIso() };
  if (patch.isRead !== undefined) {
    sets.push("is_read = @is_read");
    params.is_read = patch.isRead ? 1 : 0;
  }
  if (patch.folder !== undefined) {
    sets.push("folder = @folder");
    params.folder = patch.folder;
  }
  db.prepare(`UPDATE emails SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export function latestReceivedAt(db: Db = getDb(), userId?: string): string | null {
  const row = (userId
    ? db.prepare("SELECT MAX(received_at) AS m FROM emails WHERE direction = 'inbound' AND status != 'CONTEXT' AND user_id = ?").get(userId)
    : db.prepare("SELECT MAX(received_at) AS m FROM emails WHERE direction = 'inbound' AND status != 'CONTEXT'").get()) as { m: string | null };
  return row.m;
}

export function countEmails(opts: { since?: string; status?: EmailStatus; userId?: string } = {}, db: Db = getDb()): number {
  const clauses: string[] = ["status != 'CONTEXT'"];
  const params: Record<string, unknown> = {};
  ownerClause(opts.userId, clauses, params);
  if (opts.since) {
    clauses.push("received_at >= @since");
    params.since = opts.since;
  }
  if (opts.status) {
    clauses.push("status = @status");
    params.status = opts.status;
  }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE ${clauses.join(" AND ")}`).get(params) as { n: number };
  return row.n;
}
