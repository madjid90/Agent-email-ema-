import type { Db } from "../connection";
import { getDb } from "../connection";
import type { FollowupRow, FollowupStatus } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewFollowup {
  threadId: string;
  emailId?: string | null;
  recipient?: string | null;
  reason: string;
  executeAt: string;
  maxAttempts?: number;
}

export function insertFollowup(input: NewFollowup, db: Db = getDb()): FollowupRow {
  const id = newId("fup");
  db.prepare(
    `INSERT INTO scheduled_followups (id, thread_id, email_id, recipient, reason, execute_at, status, attempts, max_attempts, created_at)
     VALUES (@id, @thread_id, @email_id, @recipient, @reason, @execute_at, 'SCHEDULED', 0, @max_attempts, @created_at)`,
  ).run({
    id,
    thread_id: input.threadId,
    email_id: input.emailId ?? null,
    recipient: input.recipient ?? null,
    reason: input.reason,
    execute_at: input.executeAt,
    max_attempts: input.maxAttempts ?? 3,
    created_at: nowIso(),
  });
  return getFollowup(id, db) as FollowupRow;
}

export function getFollowup(id: string, db: Db = getDb()): FollowupRow | undefined {
  return db.prepare("SELECT * FROM scheduled_followups WHERE id = ?").get(id) as FollowupRow | undefined;
}

export function listFollowups(opts: { status?: FollowupStatus | FollowupStatus[]; limit?: number } = {}, db: Db = getDb()): FollowupRow[] {
  const params: Record<string, unknown> = { limit: opts.limit ?? 200 };
  let where = "";
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    where = `WHERE status IN (${statuses.map((_, i) => `@s${i}`).join(",")})`;
    statuses.forEach((s, i) => (params[`s${i}`] = s));
  }
  return db.prepare(`SELECT * FROM scheduled_followups ${where} ORDER BY execute_at ASC LIMIT @limit`).all(params) as FollowupRow[];
}

export function listDueFollowups(now: string = nowIso(), db: Db = getDb()): FollowupRow[] {
  return db
    .prepare("SELECT * FROM scheduled_followups WHERE status = 'SCHEDULED' AND execute_at <= ? ORDER BY execute_at ASC")
    .all(now) as FollowupRow[];
}

export function listActiveFollowupsForThread(threadId: string, db: Db = getDb()): FollowupRow[] {
  return db
    .prepare("SELECT * FROM scheduled_followups WHERE thread_id = ? AND status IN ('SCHEDULED','CHECKING','WAITING_APPROVAL')")
    .all(threadId) as FollowupRow[];
}

export function transitionFollowup(
  id: string,
  from: FollowupStatus | FollowupStatus[],
  to: FollowupStatus,
  extra: Partial<Pick<FollowupRow, "attempts" | "action_id" | "completed_at" | "cancelled_at" | "execute_at">> = {},
  db: Db = getDb(),
): boolean {
  const froms = Array.isArray(from) ? from : [from];
  const sets = ["status = @to"];
  const params: Record<string, unknown> = { id, to };
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  froms.forEach((s, i) => (params[`f${i}`] = s));
  const res = db
    .prepare(`UPDATE scheduled_followups SET ${sets.join(", ")} WHERE id = @id AND status IN (${froms.map((_, i) => `@f${i}`).join(",")})`)
    .run(params);
  return res.changes === 1;
}

export function cancelFollowup(id: string, db: Db = getDb()): boolean {
  return transitionFollowup(id, ["SCHEDULED", "CHECKING", "WAITING_APPROVAL"], "CANCELLED", { cancelled_at: nowIso() }, db);
}

export function rescheduleFollowup(id: string, executeAt: string, db: Db = getDb()): boolean {
  return transitionFollowup(id, ["SCHEDULED", "WAITING_APPROVAL"], "SCHEDULED", { execute_at: executeAt }, db);
}
