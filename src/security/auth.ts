import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";
import { hmacSign, hmacVerify } from "./crypto";

/**
 * Authentification mono-utilisateur de l'interface :
 * mot de passe APP_PASSWORD → cookie de session signé HMAC (APP_SECRET).
 * Si APP_PASSWORD n'est pas défini (setup initial), l'accès est ouvert en
 * développement et refusé en production.
 */
export const SESSION_COOKIE = "ema_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 jours

export function isAuthConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.APP_PASSWORD && env.APP_SECRET && env.APP_SECRET.length >= 32);
}

export function verifyPassword(candidate: string): boolean {
  const expected = getEnv().APP_PASSWORD ?? "";
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function createSessionValue(): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${exp}`;
  return `${payload}.${hmacSign(`session:${payload}`)}`;
}

export function isSessionValueValid(value: string | undefined): boolean {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return hmacVerify(`session:${exp}`, sig);
}

export async function isAuthenticated(): Promise<boolean> {
  if (!isAuthConfigured()) return getEnv().NODE_ENV !== "production";
  const store = await cookies();
  return isSessionValueValid(store.get(SESSION_COOKIE)?.value);
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
