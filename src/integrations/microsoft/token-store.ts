import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { getToken, upsertToken, deleteToken } from "@/database/repositories/tokens";
import { decryptSecret, encryptSecret } from "@/security/crypto";
import type { TokenSet } from "./types";

/**
 * Stockage chiffré des tokens Microsoft dans oauth_tokens.
 * Le blob n'est jamais loggué ni renvoyé hors de ce module et de graph-client.
 */
export const TOKEN_PROVIDER = "microsoft";

export function saveTokenSet(set: TokenSet, accountEmail: string | null, db: Db = getDb()): void {
  upsertToken(
    {
      provider: TOKEN_PROVIDER,
      accountEmail,
      encrypted: encryptSecret(JSON.stringify(set)),
      scopes: set.scope,
      expiresAt: set.expiresAt,
    },
    db,
  );
}

export function loadTokenSet(db: Db = getDb()): { set: TokenSet; accountEmail: string | null } | null {
  const row = getToken(TOKEN_PROVIDER, db);
  if (!row) return null;
  const set = JSON.parse(decryptSecret(row.encrypted)) as TokenSet;
  return { set, accountEmail: row.account_email };
}

export function clearTokenSet(db: Db = getDb()): void {
  deleteToken(TOKEN_PROVIDER, db);
}
