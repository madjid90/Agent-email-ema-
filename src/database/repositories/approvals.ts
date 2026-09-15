import type { Db } from "../connection";
import { getDb } from "../connection";
import type { ApprovalChannel, ApprovalRow, ApprovalStatus } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewApproval {
  actionId: string;
  channel: ApprovalChannel;
  summary: string;
  proposedReply?: string | null;
  expiresAt: string;
}

export function insertApproval(input: NewApproval, db: Db = getDb()): ApprovalRow {
  const id = newId("apr");
  db.prepare(
    `INSERT INTO approvals (id, action_id, channel, status, summary, proposed_reply, expires_at, created_at)
     VALUES (@id, @action_id, @channel, 'PENDING', @summary, @proposed_reply, @expires_at, @created_at)`,
  ).run({
    id,
    action_id: input.actionId,
    channel: input.channel,
    summary: input.summary,
    proposed_reply: input.proposedReply ?? null,
    expires_at: input.expiresAt,
    created_at: nowIso(),
  });
  return getApproval(id, db) as ApprovalRow;
}

export function getApproval(id: string, db: Db = getDb()): ApprovalRow | undefined {
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
}

export function getPendingApprovalForAction(actionId: string, db: Db = getDb()): ApprovalRow | undefined {
  return db
    .prepare("SELECT * FROM approvals WHERE action_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1")
    .get(actionId) as ApprovalRow | undefined;
}

/** Notification envoyée : identifiant Meta + date. Une seule notification active par approval. */
export function markApprovalSent(id: string, externalMessageId: string, db: Db = getDb()): void {
  db.prepare("UPDATE approvals SET external_message_id = ?, sent_at = ?, last_notify_error = NULL, notify_attempts = notify_attempts + 1 WHERE id = ?").run(externalMessageId, nowIso(), id);
}

export function markApprovalNotifyFailed(id: string, error: string, db: Db = getDb()): void {
  db.prepare("UPDATE approvals SET notify_attempts = notify_attempts + 1, last_notify_error = ? WHERE id = ?").run(error.slice(0, 300), id);
}

export function updateApprovalProposedReply(id: string, proposedReply: string | null, db: Db = getDb()): void {
  db.prepare("UPDATE approvals SET proposed_reply = ? WHERE id = ?").run(proposedReply, id);
}

/** Validations en attente jamais notifiées (ou en échec), bornées en tentatives. */
export function listPendingUnsentApprovals(maxAttempts: number, db: Db = getDb()): ApprovalRow[] {
  return db
    .prepare("SELECT * FROM approvals WHERE status = 'PENDING' AND external_message_id IS NULL AND notify_attempts < ? ORDER BY created_at ASC")
    .all(maxAttempts) as ApprovalRow[];
}

export function getLatestApprovalForAction(actionId: string, db: Db = getDb()): ApprovalRow | undefined {
  return db.prepare("SELECT * FROM approvals WHERE action_id = ? ORDER BY created_at DESC LIMIT 1").get(actionId) as ApprovalRow | undefined;
}

/** Décision à usage unique : ne change que si encore PENDING. */
export function decideApproval(
  id: string,
  status: Exclude<ApprovalStatus, "PENDING">,
  decidedBy: string,
  comment?: string | null,
  db: Db = getDb(),
): boolean {
  const res = db
    .prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, comment = ? WHERE id = ? AND status = 'PENDING'")
    .run(status, nowIso(), decidedBy, comment ?? null, id);
  return res.changes === 1;
}

export function listPendingApprovals(db: Db = getDb()): ApprovalRow[] {
  return db.prepare("SELECT * FROM approvals WHERE status = 'PENDING' ORDER BY created_at ASC").all() as ApprovalRow[];
}

export function listExpiredPendingApprovals(now: string = nowIso(), db: Db = getDb()): ApprovalRow[] {
  return db.prepare("SELECT * FROM approvals WHERE status = 'PENDING' AND expires_at <= ?").all(now) as ApprovalRow[];
}
