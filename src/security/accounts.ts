import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { adoptOrphanConnections } from "@/database/repositories/connections";
import { logHistory } from "@/database/repositories/history";
import { countUsers, createUser, getUserByEmail, touchLogin } from "@/database/repositories/users";
import type { UserRow } from "@/database/types";
import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPasswordHash } from "./passwords";

const log = createLogger("security.accounts");

/**
 * Création et vérification des comptes. Le premier compte est toujours
 * possible (il devient `owner` et adopte une éventuelle connexion Outlook
 * antérieure) ; les suivants exigent ALLOW_SIGNUP=true — c'est ainsi qu'un
 * nouveau client est ajouté sans toucher au code.
 */
export function isSignupAllowed(db: Db = getDb()): boolean {
  return countUsers(db) === 0 || getEnv().ALLOW_SIGNUP;
}

export function registerAccount(input: { email: string; password: string; name?: string | null; phoneNumber?: string | null }, db: Db = getDb()): UserRow {
  if (!isSignupAllowed(db)) throw new EmaError("FORBIDDEN", "La création de compte est désactivée sur cette instance (ALLOW_SIGNUP)");
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new EmaError("VALIDATION", `Mot de passe trop court : ${MIN_PASSWORD_LENGTH} caractères minimum`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new EmaError("VALIDATION", "Adresse email invalide");
  const first = countUsers(db) === 0;
  const user = createUser({ email: input.email, name: input.name ?? null, passwordHash: hashPassword(input.password), role: first ? "owner" : "user", phoneNumber: input.phoneNumber ?? null }, db);
  if (first) {
    const adopted = adoptOrphanConnections(user.id, db);
    if (adopted) log.info("legacy connection adopted by first account", { userId: user.id });
  }
  logHistory({ eventType: "user.created", message: `Compte créé : ${user.email}${first ? " (propriétaire)" : ""}`, actor: "user", userId: user.id }, db);
  log.info("account created", { userId: user.id, role: user.role });
  return user;
}

/** Vérifie email + mot de passe. Renvoie l'utilisateur actif, sinon null (sans distinguer la cause). */
export function authenticate(email: string, password: string, db: Db = getDb()): UserRow | null {
  const user = getUserByEmail(email, db);
  const ok = verifyPasswordHash(password, user?.password_hash ?? "scrypt$AA==$AA==");
  if (!user || !ok || user.status !== "active") return null;
  touchLogin(user.id, db);
  return user;
}
