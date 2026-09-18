import type { Db } from "../connection";
import { getDb } from "../connection";
import type { FollowupKind, FollowupRow, FollowupStatus } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewFollowup {
  /** Propriétaire ; à défaut, hérité de l'email surveillé. */
  userId?: string | null;
  kind?: FollowupKind;
  threadId: string;
  emailId?: string | null;
  recipient?: string | null;
  companyId?: string | null;
  documentId?: string | null;
  title?: string | null;
  reason: string;
  executeAt: string;
  /** Ancrage : seuls les messages postérieurs comptent comme réponse. */
  watchAfter?: string | null;
  maxAttempts?: number;
  actionId?: string | null;
  createdBy?: string;
}

function ownerOf(input: NewFollowup, db: Db): string | null {
  if (input.userId) return input.userId;
  if (input.emailId) {
    const e = db.prepare("SELECT user_id FROM emails WHERE id = ?").get(input.emailId) as { user_id: string | null } | undefined;
    if (e?.user_id) return e.user_id;
  }
  const t = db.prepare("SELECT user_id FROM emails WHERE thread_id = ? AND user_id IS NOT NULL LIMIT 1").get(input.threadId) as { user_id: string | null } | undefined;
  return t?.user_id ?? null;
}

export function insertFollowup(input: NewFollowup, db: Db = getDb()): FollowupRow {
  const id = newId("fup");
  const now = nowIso();
  db.prepare(
    `INSERT INTO scheduled_followups (id, user_id, kind, thread_id, email_id, recipient, company_id, document_id, title, reason, execute_at, watch_after, status, attempts, max_attempts, action_id, created_by, created_at, updated_at)
     VALUES (@id, @user_id, @kind, @thread_id, @email_id, @recipient, @company_id, @document_id, @title, @reason, @execute_at, @watch_after, 'SCHEDULED', 0, @max_attempts, @action_id, @created_by, @created_at, @created_at)`,
  ).run({
    id,
    user_id: ownerOf(input, db),
    kind: input.kind ?? "EXTERNAL_FOLLOWUP",
    thread_id: input.threadId,
    email_id: input.emailId ?? null,
    recipient: input.recipient ?? null,
    company_id: input.companyId ?? null,
    document_id: input.documentId ?? null,
    title: input.title ?? null,
    reason: input.reason,
    execute_at: input.executeAt,
    watch_after: input.watchAfter ?? null,
    max_attempts: input.maxAttempts ?? 2,
    action_id: input.actionId ?? null,
    created_by: input.createdBy ?? "user",
    created_at: now,
  });
  return getFollowup(id, db) as FollowupRow;
}

export function getFollowup(id: string, db: Db = getDb()): FollowupRow | undefined {
  return db.prepare("SELECT * FROM scheduled_followups WHERE id = ?").get(id) as FollowupRow | undefined;
}

export function getFollowupByGeneratedAction(actionId: string, db: Db = getDb()): FollowupRow | undefined {
  return db.prepare("SELECT * FROM scheduled_followups WHERE generated_action_id = ?").get(actionId) as FollowupRow | undefined;
}

export interface FollowupSearch {
  userId?: string;
  status?: FollowupStatus | FollowupStatus[];
  kind?: FollowupKind;
  threadId?: string;
  dueBefore?: string;
  limit?: number;
}

export function listFollowups(opts: FollowupSearch = {}, db: Db = getDb()): FollowupRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 200 };
  if (opts.userId) {
    clauses.push("user_id = @user_id");
    params.user_id = opts.userId;
  }
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    clauses.push(`status IN (${statuses.map((_, i) => `@s${i}`).join(",")})`);
    statuses.forEach((s, i) => (params[`s${i}`] = s));
  }
  if (opts.kind) {
    clauses.push("kind = @kind");
    params.kind = opts.kind;
  }
  if (opts.threadId) {
    clauses.push("thread_id = @thread_id");
    params.thread_id = opts.threadId;
  }
  if (opts.dueBefore) {
    clauses.push("execute_at <= @due_before");
    params.due_before = opts.dueBefore;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM scheduled_followups ${where} ORDER BY execute_at ASC LIMIT @limit`).all(params) as FollowupRow[];
}

/** Relances échues à traiter : programmées ou dont la vérification Outlook a échoué. */
export function listDueFollowups(now: string = nowIso(), db: Db = getDb()): FollowupRow[] {
  return db
    .prepare("SELECT * FROM scheduled_followups WHERE status IN ('SCHEDULED','CHECK_FAILED') AND execute_at <= ? ORDER BY execute_at ASC")
    .all(now) as FollowupRow[];
}

export function listActiveFollowupsForThread(threadId: string, db: Db = getDb()): FollowupRow[] {
  return db
    .prepare("SELECT * FROM scheduled_followups WHERE thread_id = ? AND status IN ('SCHEDULED','CHECKING','CHECK_FAILED','WAITING_APPROVAL','REVIEW_REQUIRED','REMINDED')")
    .all(threadId) as FollowupRow[];
}

export type FollowupPatch = Partial<
  Pick<
    FollowupRow,
    | "attempts" | "action_id" | "generated_action_id" | "completed_at" | "cancelled_at" | "execute_at" | "watch_after"
    | "last_checked_at" | "last_reply_email_id" | "last_error" | "cancellation_reason" | "requires_human_review"
    | "notification_pending" | "notify_attempts" | "notified_at" | "recipient" | "reason" | "title" | "max_attempts"
  >
>;

/**
 * Transition atomique : le statut n'est modifié que si la relance est encore
 * dans l'un des statuts attendus. C'est la garantie anti-double-traitement
 * (deux workers, deux cycles, reprise après crash).
 */
export function transitionFollowup(id: string, from: FollowupStatus | FollowupStatus[], to: FollowupStatus, extra: FollowupPatch = {}, db: Db = getDb()): boolean {
  const froms = Array.isArray(from) ? from : [from];
  const sets = ["status = @to", "updated_at = @updated_at"];
  const params: Record<string, unknown> = { id, to, updated_at: nowIso() };
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

export function updateFollowup(id: string, patch: FollowupPatch, db: Db = getDb()): void {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = @${k}`);
  sets.push("updated_at = @updated_at");
  db.prepare(`UPDATE scheduled_followups SET ${sets.join(", ")} WHERE id = @id`).run({ id, updated_at: nowIso(), ...patch });
}

export function cancelFollowup(id: string, reason?: string, db: Db = getDb()): boolean {
  return transitionFollowup(
    id,
    ["SCHEDULED", "CHECKING", "CHECK_FAILED", "WAITING_APPROVAL", "REVIEW_REQUIRED", "REMINDED", "FAILED", "MAX_ATTEMPTS_REACHED"],
    "CANCELLED",
    { cancelled_at: nowIso(), cancellation_reason: reason ?? null },
    db,
  );
}

/** Report : nouvelle échéance, retour à SCHEDULED, historique conservé (aucun doublon créé). */
export function rescheduleFollowup(id: string, executeAt: string, db: Db = getDb()): boolean {
  return transitionFollowup(
    id,
    ["SCHEDULED", "CHECK_FAILED", "WAITING_APPROVAL", "REVIEW_REQUIRED", "REMINDED", "FAILED", "MAX_ATTEMPTS_REACHED"],
    "SCHEDULED",
    { execute_at: executeAt, notification_pending: 0, notified_at: null, last_error: null },
    db,
  );
}

export interface FollowupStats {
  today: number;
  upcoming: number;
  waitingApproval: number;
  responded: number;
  reminders: number;
  needsAttention: number;
}

export function followupStats(dayStart: string, dayEnd: string, db: Db = getDb()): FollowupStats {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('SCHEDULED','CHECK_FAILED','CHECKING') AND execute_at <= @day_end THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN status IN ('SCHEDULED','CHECK_FAILED','CHECKING') AND execute_at > @day_end THEN 1 ELSE 0 END) AS upcoming,
         SUM(CASE WHEN status = 'WAITING_APPROVAL' THEN 1 ELSE 0 END) AS waiting,
         SUM(CASE WHEN status = 'RESPONSE_RECEIVED' AND updated_at >= @day_start THEN 1 ELSE 0 END) AS responded,
         SUM(CASE WHEN kind = 'INTERNAL_REMINDER' AND status IN ('SCHEDULED','REMINDED') THEN 1 ELSE 0 END) AS reminders,
         SUM(CASE WHEN status IN ('MAX_ATTEMPTS_REACHED','REVIEW_REQUIRED','FAILED') THEN 1 ELSE 0 END) AS attention
       FROM scheduled_followups`,
    )
    .get({ day_start: dayStart, day_end: dayEnd }) as Record<string, number | null>;
  return {
    today: row.today ?? 0,
    upcoming: row.upcoming ?? 0,
    waitingApproval: row.waiting ?? 0,
    responded: row.responded ?? 0,
    reminders: row.reminders ?? 0,
    needsAttention: row.attention ?? 0,
  };
}
