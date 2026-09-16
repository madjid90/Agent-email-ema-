import type { Db } from "../connection";
import { getDb } from "../connection";
import type { ActionRow, ActionStatus, RiskLevel } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewActionRow {
  type: string;
  title: string;
  sourceEmailId?: string | null;
  companyId?: string | null;
  documentId?: string | null;
  payload: unknown;
  status: ActionStatus;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

export function insertAction(input: NewActionRow, db: Db = getDb()): ActionRow {
  const id = newId("act");
  db.prepare(
    `INSERT INTO actions (id, type, source_email_id, company_id, document_id, payload, status, risk_level, requires_approval, title, created_at)
     VALUES (@id, @type, @source_email_id, @company_id, @document_id, @payload, @status, @risk_level, @requires_approval, @title, @created_at)`,
  ).run({
    id,
    type: input.type,
    source_email_id: input.sourceEmailId ?? null,
    company_id: input.companyId ?? null,
    document_id: input.documentId ?? null,
    payload: JSON.stringify(input.payload ?? {}),
    status: input.status,
    risk_level: input.riskLevel,
    requires_approval: input.requiresApproval ? 1 : 0,
    title: input.title,
    created_at: nowIso(),
  });
  return getAction(id, db) as ActionRow;
}

export function getAction(id: string, db: Db = getDb()): ActionRow | undefined {
  return db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as ActionRow | undefined;
}

export function listActions(opts: { status?: ActionStatus | ActionStatus[]; limit?: number; since?: string } = {}, db: Db = getDb()): ActionRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 100 };
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    clauses.push(`status IN (${statuses.map((_, i) => `@s${i}`).join(",")})`);
    statuses.forEach((s, i) => (params[`s${i}`] = s));
  }
  if (opts.since) {
    clauses.push("created_at >= @since");
    params.since = opts.since;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM actions ${where} ORDER BY created_at DESC LIMIT @limit`).all(params) as ActionRow[];
}

export function listActionsForEmail(emailId: string, db: Db = getDb()): ActionRow[] {
  return db.prepare("SELECT * FROM actions WHERE source_email_id = ? ORDER BY created_at DESC").all(emailId) as ActionRow[];
}

/**
 * Transition conditionnelle : ne modifie la ligne que si elle est dans l'un des
 * statuts attendus. Retourne true si exactement une ligne a changé.
 * C'est la brique d'idempotence de l'Action Engine.
 */
export type ActionPatchFields = "approved_at" | "executed_at" | "completed_at" | "error" | "error_code" | "result";

export function transitionAction(
  id: string,
  from: ActionStatus | ActionStatus[],
  to: ActionStatus,
  extra: Partial<Pick<ActionRow, ActionPatchFields>> = {},
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
    .prepare(`UPDATE actions SET ${sets.join(", ")} WHERE id = @id AND status IN (${froms.map((_, i) => `@f${i}`).join(",")})`)
    .run(params);
  return res.changes === 1;
}

export function updateActionPayload(id: string, payload: unknown, db: Db = getDb()): void {
  db.prepare("UPDATE actions SET payload = ? WHERE id = ?").run(JSON.stringify(payload ?? {}), id);
}

/** Actions interrompues : validées ou en cours d'exécution depuis trop longtemps. */
export function listStaleActions(status: ActionStatus, olderThanIso: string, db: Db = getDb()): ActionRow[] {
  const column = status === "APPROVED" ? "approved_at" : "executed_at";
  return db
    .prepare(`SELECT * FROM actions WHERE status = ? AND COALESCE(${column}, created_at) <= ? ORDER BY created_at ASC LIMIT 20`)
    .all(status, olderThanIso) as ActionRow[];
}

export function countActions(opts: { status?: ActionStatus | ActionStatus[]; since?: string } = {}, db: Db = getDb()): number {
  return listActions({ ...opts, limit: 100000 }, db).length;
}
