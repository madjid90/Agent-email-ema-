import type { Db } from "../connection";
import { getDb } from "../connection";
import type { ConnectionRow } from "../types";
import { deleteConnection, getConnection, getConnectionInfo, upsertConnection } from "./connections";

/**
 * Compatibilité : l'ancienne table `oauth_tokens` (une ligne par fournisseur)
 * est remplacée par `connections` (une ligne par utilisateur et fournisseur).
 * Ces fonctions restent disponibles pour les appels non scopés.
 */
export function upsertToken(input: { provider: string; accountEmail?: string | null; encrypted: string; scopes?: string; expiresAt?: string | null; userId?: string | null }, db: Db = getDb()): void {
  upsertConnection({ userId: input.userId ?? null, provider: input.provider, encrypted: input.encrypted, scopes: input.scopes, expiresAt: input.expiresAt, accountEmail: input.accountEmail }, db);
}

export function getToken(provider: string, db: Db = getDb(), userId?: string | null): ConnectionRow | undefined {
  return getConnection(provider, userId, db);
}

export function deleteToken(provider: string, db: Db = getDb(), userId?: string | null): void {
  deleteConnection(provider, userId, db);
}

export function getTokenInfo(provider: string, db: Db = getDb(), userId?: string | null): { accountEmail: string | null; scopes: string; expiresAt: string | null; updatedAt: string } | null {
  return getConnectionInfo(provider, userId, db);
}
