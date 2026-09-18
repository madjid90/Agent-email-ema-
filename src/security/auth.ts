import { cookies } from "next/headers";
import { getDb, type Db } from "@/database/connection";
import { getUser } from "@/database/repositories/users";
import type { UserRow } from "@/database/types";
import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { hmacSign, hmacVerify } from "./crypto";

/**
 * Authentification par compte utilisateur : email + mot de passe (scrypt) →
 * cookie de session signé HMAC (APP_SECRET) portant l'identifiant du compte.
 * L'identité côté serveur vient TOUJOURS de ce cookie : jamais d'un paramètre,
 * jamais du modèle. Rien n'est stocké côté client à part la valeur signée.
 */
export const SESSION_COOKIE = "ema_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 jours

export function isAuthConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.APP_SECRET && env.APP_SECRET.length >= 32);
}

/** Valeur de session : `<user_id>.<expiration>.<signature>`. */
export function createSessionValue(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return `${userId}.${exp}.${hmacSign(`session:${userId}:${exp}`)}`;
}

/** Identifiant du compte si la valeur est authentique et non expirée, sinon null. */
export function parseSessionValue(value: string | undefined): string | null {
  if (!value) return null;
  const [userId, exp, sig] = value.split(".");
  if (!userId || !exp || !sig) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return hmacVerify(`session:${userId}:${exp}`, sig) ? userId : null;
}

/** Compat : `true` si la valeur correspond à une session valide. */
export function isSessionValueValid(value: string | undefined): boolean {
  return parseSessionValue(value) !== null;
}

/** Utilisateur de la requête courante (cookie de session), ou null. */
export async function getSessionUser(db: Db = getDb()): Promise<UserRow | null> {
  if (!isAuthConfigured()) return null;
  const store = await cookies();
  const userId = parseSessionValue(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  const user = getUser(userId, db);
  return user && user.status === "active" ? user : null;
}

export async function isAuthenticated(): Promise<boolean> {
  return (await getSessionUser()) !== null;
}

/** Lève UNAUTHORIZED si aucun compte n'est connecté. */
export async function requireSessionUser(db: Db = getDb()): Promise<UserRow> {
  const user = await getSessionUser(db);
  if (!user) throw new EmaError("UNAUTHORIZED", "Authentification requise");
  return user;
}

export function sessionCookieOptions(): { name: string; httpOnly: true; sameSite: "lax"; secure: boolean; path: string; maxAge: number } {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: "lax",
    secure: getEnv().NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
