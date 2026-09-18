import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { deleteConnection, getConnection, setConnectionStatus, upsertConnection } from "@/database/repositories/connections";
import { decryptSecret, encryptSecret } from "@/security/crypto";
import type { TokenSet } from "./types";

/**
 * Stockage chiffré des tokens Microsoft, PAR UTILISATEUR, dans `connections`.
 * Le blob n'est jamais loggué ni renvoyé hors de ce module et de graph-client.
 *
 * `userId` :
 * - chaîne : connexion de cet utilisateur uniquement ;
 * - undefined (appel non scopé) : connexion renvoyée seulement si elle est la
 *   seule de l'instance — jamais la boîte d'un autre utilisateur par défaut.
 */
export const TOKEN_PROVIDER = "microsoft";

export interface StoredTokenSet {
  set: TokenSet;
  accountEmail: string | null;
  userId: string | null;
  connectionId: string;
  status: "active" | "revoked";
}

export function saveTokenSet(set: TokenSet, accountEmail: string | null, db: Db = getDb(), userId: string | null = null): void {
  upsertConnection({ userId, provider: TOKEN_PROVIDER, accountEmail, encrypted: encryptSecret(JSON.stringify(set)), scopes: set.scope, expiresAt: set.expiresAt }, db);
}

export function loadTokenSet(db: Db = getDb(), userId?: string | null): StoredTokenSet | null {
  const row = getConnection(TOKEN_PROVIDER, userId, db);
  if (!row) return null;
  const set = JSON.parse(decryptSecret(row.encrypted)) as TokenSet;
  return { set, accountEmail: row.provider_account_email, userId: row.user_id, connectionId: row.id, status: row.status };
}

export function clearTokenSet(db: Db = getDb(), userId?: string | null): void {
  deleteConnection(TOKEN_PROVIDER, userId, db);
}

/** Refresh refusé par Microsoft (token révoqué, mot de passe changé, consentement retiré). */
export function markTokenRevoked(connectionId: string, reason: string, db: Db = getDb()): void {
  setConnectionStatus(connectionId, "revoked", reason.slice(0, 200), db);
}
