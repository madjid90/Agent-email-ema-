import type { Db } from "../connection";
import { getDb } from "../connection";
import type { ConnectionRow, ConnectionStatus } from "../types";
import { newId, nowIso } from "@/lib/ids";

/**
 * Connexions externes par utilisateur (Microsoft). Le blob est déjà chiffré
 * par src/security/crypto.ts : jamais de token en clair ici, jamais dans les
 * journaux. Une connexion `user_id NULL` est un reliquat d'avant 010_users.
 */
export function upsertConnection(
  input: { userId: string | null; provider: string; encrypted: string; scopes?: string; expiresAt?: string | null; accountEmail?: string | null; organizationId?: string | null },
  db: Db = getDb(),
): ConnectionRow {
  const now = nowIso();
  const existing = getConnection(input.provider, input.userId, db);
  if (existing) {
    db.prepare(
      `UPDATE connections SET encrypted = @encrypted, scopes = @scopes, expires_at = @expires_at, provider_account_email = @account_email,
         status = 'active', last_error = NULL, updated_at = @now WHERE id = @id`,
    ).run({ id: existing.id, encrypted: input.encrypted, scopes: input.scopes ?? "", expires_at: input.expiresAt ?? null, account_email: input.accountEmail ?? null, now });
    return getConnectionById(existing.id, db) as ConnectionRow;
  }
  const id = newId("con");
  db.prepare(
    `INSERT INTO connections (id, user_id, organization_id, provider, encrypted, scopes, expires_at, provider_account_email, status, created_at, updated_at)
     VALUES (@id, @user_id, @organization_id, @provider, @encrypted, @scopes, @expires_at, @account_email, 'active', @now, @now)`,
  ).run({ id, user_id: input.userId, organization_id: input.organizationId ?? null, provider: input.provider, encrypted: input.encrypted, scopes: input.scopes ?? "", expires_at: input.expiresAt ?? null, account_email: input.accountEmail ?? null, now });
  return getConnectionById(id, db) as ConnectionRow;
}

export function getConnectionById(id: string, db: Db = getDb()): ConnectionRow | undefined {
  return db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as ConnectionRow | undefined;
}

/**
 * Connexion d'un utilisateur. `userId === undefined` (appel non scopé, hérité
 * de l'instance mono-utilisateur) : renvoie la connexion uniquement si elle est
 * SANS AMBIGUÏTÉ, c'est-à-dire s'il n'en existe qu'une seule pour ce fournisseur.
 * Dès qu'un second utilisateur est connecté, un appel non scopé ne renvoie rien :
 * jamais la boîte d'un autre utilisateur par défaut.
 */
export function getConnection(provider: string, userId: string | null | undefined, db: Db = getDb()): ConnectionRow | undefined {
  if (userId === undefined) {
    const rows = db.prepare("SELECT * FROM connections WHERE provider = ?").all(provider) as ConnectionRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }
  if (userId === null) return db.prepare("SELECT * FROM connections WHERE provider = ? AND user_id IS NULL").get(provider) as ConnectionRow | undefined;
  return db.prepare("SELECT * FROM connections WHERE provider = ? AND user_id = ?").get(provider, userId) as ConnectionRow | undefined;
}

export function deleteConnection(provider: string, userId: string | null | undefined, db: Db = getDb()): void {
  const row = getConnection(provider, userId, db);
  if (row) db.prepare("DELETE FROM connections WHERE id = ?").run(row.id);
}

export function setConnectionStatus(id: string, status: ConnectionStatus, lastError: string | null, db: Db = getDb()): void {
  db.prepare("UPDATE connections SET status = ?, last_error = ?, updated_at = ? WHERE id = ?").run(status, lastError, nowIso(), id);
}

/** Utilisateurs disposant d'une connexion active (synchronisation par le worker). */
export function listActiveConnections(provider: string, db: Db = getDb()): ConnectionRow[] {
  return db.prepare("SELECT * FROM connections WHERE provider = ? AND status = 'active' AND user_id IS NOT NULL ORDER BY created_at ASC").all(provider) as ConnectionRow[];
}

/** Reliquat mono-utilisateur : la connexion sans propriétaire est attribuée au premier compte. */
export function adoptOrphanConnections(userId: string, db: Db = getDb()): number {
  return db.prepare("UPDATE connections SET user_id = ?, updated_at = ? WHERE user_id IS NULL").run(userId, nowIso()).changes;
}

/** Métadonnées sans le blob chiffré (pour l'UI). */
export function getConnectionInfo(provider: string, userId: string | null | undefined, db: Db = getDb()): { accountEmail: string | null; scopes: string; expiresAt: string | null; updatedAt: string; status: ConnectionStatus; lastError: string | null } | null {
  const row = getConnection(provider, userId, db);
  if (!row) return null;
  return { accountEmail: row.provider_account_email, scopes: row.scopes, expiresAt: row.expires_at, updatedAt: row.updated_at, status: row.status, lastError: row.last_error };
}
