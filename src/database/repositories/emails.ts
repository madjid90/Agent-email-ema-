import type { Db } from "../connection";
import { getDb } from "../connection";
import type { EmailRow, EmailStatus } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewEmail {
  graphId: string;
  threadId?: string | null;
  direction?: "inbound" | "outbound";
  senderName?: string | null;
  senderEmail?: string | null;
  toRecipients?: string[];
  subject: string;
  bodyPreview?: string;
  bodyText?: string | null;
  receivedAt: string;
  hasAttachments?: boolean;
}

export function insertEmail(input: NewEmail, db: Db = getDb()): EmailRow {
  const id = newId("eml");
  const now = nowIso();
  db.prepare(
    `INSERT INTO emails (id, graph_id, thread_id, direction, sender_name, sender_email, to_recipients, subject, body_preview, body_text, received_at, has_attachments, status, created_at, updated_at)
     VALUES (@id, @graph_id, @thread_id, @direction, @sender_name, @sender_email, @to_recipients, @subject, @body_preview, @body_text, @received_at, @has_attachments, 'NEW', @now, @now)`,
  ).run({
    id,
    graph_id: input.graphId,
    thread_id: input.threadId ?? null,
    direction: input.direction ?? "inbound",
    sender_name: input.senderName ?? null,
    sender_email: input.senderEmail ?? null,
    to_recipients: JSON.stringify(input.toRecipients ?? []),
    subject: input.subject,
    body_preview: input.bodyPreview ?? "",
    body_text: input.bodyText ?? null,
    received_at: input.receivedAt,
    has_attachments: input.hasAttachments ? 1 : 0,
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

export function listEmails(opts: { status?: EmailStatus; limit?: number; since?: string } = {}, db: Db = getDb()): EmailRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 50 };
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

export function listThread(threadId: string, db: Db = getDb()): EmailRow[] {
  return db.prepare("SELECT * FROM emails WHERE thread_id = ? ORDER BY received_at ASC").all(threadId) as EmailRow[];
}

export function updateEmailStatus(id: string, status: EmailStatus, db: Db = getDb()): void {
  db.prepare("UPDATE emails SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
}

export function countEmails(opts: { since?: string; status?: EmailStatus } = {}, db: Db = getDb()): number {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.since) {
    clauses.push("received_at >= @since");
    params.since = opts.since;
  }
  if (opts.status) {
    clauses.push("status = @status");
    params.status = opts.status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db.prepare(`SELECT COUNT(*) AS n FROM emails ${where}`).get(params) as { n: number };
  return row.n;
}
