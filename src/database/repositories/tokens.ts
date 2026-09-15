import type { Db } from "../connection";
import { getDb } from "../connection";
import type { OAuthTokenRow } from "../types";
import { nowIso } from "@/lib/ids";

/** Stocke un blob déjà chiffré (voir src/security/crypto.ts). Jamais de token en clair ici. */
export function upsertToken(
  input: { provider: string; accountEmail?: string | null; encrypted: string; scopes?: string; expiresAt?: string | null },
  db: Db = getDb(),
): void {
  db.prepare(
    `INSERT INTO oauth_tokens (provider, account_email, encrypted, scopes, expires_at, updated_at)
     VALUES (@provider, @account_email, @encrypted, @scopes, @expires_at, @updated_at)
     ON CONFLICT(provider) DO UPDATE SET account_email = excluded.account_email, encrypted = excluded.encrypted,
       scopes = excluded.scopes, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
  ).run({
    provider: input.provider,
    account_email: input.accountEmail ?? null,
    encrypted: input.encrypted,
    scopes: input.scopes ?? "",
    expires_at: input.expiresAt ?? null,
    updated_at: nowIso(),
  });
}

export function getToken(provider: string, db: Db = getDb()): OAuthTokenRow | undefined {
  return db.prepare("SELECT * FROM oauth_tokens WHERE provider = ?").get(provider) as OAuthTokenRow | undefined;
}

export function deleteToken(provider: string, db: Db = getDb()): void {
  db.prepare("DELETE FROM oauth_tokens WHERE provider = ?").run(provider);
}

/** Métadonnées sans le blob chiffré (pour l'UI). */
export function getTokenInfo(provider: string, db: Db = getDb()): { accountEmail: string | null; scopes: string; expiresAt: string | null; updatedAt: string } | null {
  const row = getToken(provider, db);
  if (!row) return null;
  return { accountEmail: row.account_email, scopes: row.scopes, expiresAt: row.expires_at, updatedAt: row.updated_at };
}
