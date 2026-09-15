import type { Db } from "../connection";
import { getDb } from "../connection";
import type { EmailRow, EmailStatus } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewEmail {
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
    `INSERT INTO emails (id, graph_id, thread_id, internet_message_id, direction, sender_name, sender_email, to_recipients, cc_recipients, subject, body_preview, body_text, received_at, sent_at, has_attachments, is_read, web_link, folder, status, created_at, updated_at)
     VALUES (@id, @graph_id, @thread_id, @internet_message_id, @direction, @sender_name, @sender_email, @to_recipients, @cc_recipients, @subject, @body_preview, @body_text, @received_at, @sent_at, @has_attachments, @is_read, @web_link, @folder, @status, @now, @now)`,
  ).run({
    id,
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

export function latestReceivedAt(db: Db = getDb()): string | null {
  const row = db.prepare("SELECT MAX(received_at) AS m FROM emails WHERE direction = 'inbound' AND status != 'CONTEXT'").get() as { m: string | null };
  return row.m;
}

export function countEmails(opts: { since?: string; status?: EmailStatus } = {}, db: Db = getDb()): number {
  const clauses: string[] = ["status != 'CONTEXT'"];
  const params: Record<string, unknown> = {};
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
