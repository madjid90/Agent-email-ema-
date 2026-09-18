import type { Db } from "../connection";
import { getDb } from "../connection";
import { nowIso } from "@/lib/ids";

/** Statuts renvoyés par Composio pour un compte connecté. */
export type ComposioAccountStatus = "INITIALIZING" | "INITIATED" | "ACTIVE" | "FAILED" | "EXPIRED" | "INACTIVE" | "REVOKED";

export interface ComposioConnectionRow {
  user_id: string;
  toolkit: string;
  connected_account_id: string;
  auth_config_id: string;
  status: ComposioAccountStatus;
  status_reason: string | null;
  account_email: string | null;
  requested_scopes: string; // JSON string[]
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Référence Composio d'UN utilisateur (jamais de token). */
export function getComposioConnection(userId: string, db: Db = getDb()): ComposioConnectionRow | undefined {
  return db.prepare("SELECT * FROM composio_connections WHERE user_id = ?").get(userId) as ComposioConnectionRow | undefined;
}

export function upsertComposioConnection(input: { userId: string; connectedAccountId: string; authConfigId: string; status: ComposioAccountStatus; toolkit?: string }, db: Db = getDb()): ComposioConnectionRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO composio_connections (user_id, toolkit, connected_account_id, auth_config_id, status, created_at, updated_at)
     VALUES (@user_id, @toolkit, @connected_account_id, @auth_config_id, @status, @now, @now)
     ON CONFLICT(user_id) DO UPDATE SET toolkit = excluded.toolkit, connected_account_id = excluded.connected_account_id, auth_config_id = excluded.auth_config_id,
       status = excluded.status, status_reason = NULL, account_email = NULL, requested_scopes = '[]', last_error = NULL, last_checked_at = NULL, updated_at = excluded.updated_at`,
  ).run({ user_id: input.userId, toolkit: input.toolkit ?? "outlook", connected_account_id: input.connectedAccountId, auth_config_id: input.authConfigId, status: input.status, now });
  return getComposioConnection(input.userId, db) as ComposioConnectionRow;
}

export function updateComposioConnection(
  userId: string,
  patch: { status?: ComposioAccountStatus; statusReason?: string | null; accountEmail?: string | null; requestedScopes?: string[]; lastError?: string | null; checked?: boolean },
  db: Db = getDb(),
): void {
  const sets: string[] = ["updated_at = @now"];
  const params: Record<string, unknown> = { user_id: userId, now: nowIso() };
  if (patch.status !== undefined) {
    sets.push("status = @status");
    params.status = patch.status;
  }
  if (patch.statusReason !== undefined) {
    sets.push("status_reason = @status_reason");
    params.status_reason = patch.statusReason;
  }
  if (patch.accountEmail !== undefined) {
    sets.push("account_email = @account_email");
    params.account_email = patch.accountEmail;
  }
  if (patch.requestedScopes !== undefined) {
    sets.push("requested_scopes = @requested_scopes");
    params.requested_scopes = JSON.stringify(patch.requestedScopes);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error = @last_error");
    params.last_error = patch.lastError ? patch.lastError.slice(0, 300) : null;
  }
  if (patch.checked) sets.push("last_checked_at = @now");
  db.prepare(`UPDATE composio_connections SET ${sets.join(", ")} WHERE user_id = @user_id`).run(params);
}

export function deleteComposioConnection(userId: string, db: Db = getDb()): void {
  db.prepare("DELETE FROM composio_connections WHERE user_id = ?").run(userId);
}
