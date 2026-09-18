import type { Db } from "../connection";
import { getDb } from "../connection";
import type { UserRole, UserRow } from "../types";
import { newId, nowIso } from "@/lib/ids";
import { EmaError } from "@/lib/errors";
import { normalizePhone } from "@/lib/phone";

/**
 * Comptes utilisateurs EMA. Le numéro de téléphone (E.164) est l'identité
 * WhatsApp : la relation numéro → utilisateur → connexion Microsoft →
 * conversations doit être fiable, d'où l'unicité parmi les comptes actifs.
 */
export interface NewUser {
  email: string;
  name?: string | null;
  passwordHash?: string | null;
  role?: UserRole;
  organizationId?: string | null;
  phoneNumber?: string | null;
}

export function createUser(input: NewUser, db: Db = getDb()): UserRow {
  const email = input.email.trim().toLowerCase();
  if (getUserByEmail(email, db)) throw new EmaError("CONFLICT", "Un compte existe déjà avec cette adresse email");
  const phone = input.phoneNumber ? normalizePhone(input.phoneNumber) : null;
  if (input.phoneNumber && !phone) throw new EmaError("VALIDATION", "Numéro de téléphone invalide (format attendu : +33 6 12 34 56 78)");
  if (phone && getUserByPhone(phone, db)) throw new EmaError("CONFLICT", "Ce numéro est déjà associé à un autre compte EMA");
  const id = newId("usr");
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, organization_id, email, name, password_hash, role, status, phone_number, phone_verified, whatsapp_enabled, created_at, updated_at)
     VALUES (@id, @organization_id, @email, @name, @password_hash, @role, 'active', @phone_number, 0, 0, @now, @now)`,
  ).run({ id, organization_id: input.organizationId ?? null, email, name: input.name?.trim() || null, password_hash: input.passwordHash ?? null, role: input.role ?? "user", phone_number: phone, now });
  return getUser(id, db) as UserRow;
}

export function getUser(id: string, db: Db = getDb()): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getUserByEmail(email: string, db: Db = getDb()): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email.trim().toLowerCase()) as UserRow | undefined;
}

/** Utilisateur ACTIF possédant ce numéro (E.164). Un compte désactivé n'est jamais renvoyé. */
export function getUserByPhone(phoneE164: string, db: Db = getDb()): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE phone_number = ? AND status = 'active'").get(phoneE164) as UserRow | undefined;
}

export function listUsers(db: Db = getDb()): UserRow[] {
  return db.prepare("SELECT * FROM users ORDER BY created_at ASC").all() as UserRow[];
}

export function countUsers(db: Db = getDb()): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function touchLogin(id: string, db: Db = getDb()): void {
  db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), id);
}

export function updateUser(id: string, patch: { name?: string | null; passwordHash?: string; status?: UserRow["status"] }, db: Db = getDb()): void {
  const sets: string[] = ["updated_at = @now"];
  const params: Record<string, unknown> = { id, now: nowIso() };
  if (patch.name !== undefined) {
    sets.push("name = @name");
    params.name = patch.name;
  }
  if (patch.passwordHash !== undefined) {
    sets.push("password_hash = @password_hash");
    params.password_hash = patch.passwordHash;
  }
  if (patch.status !== undefined) {
    sets.push("status = @status");
    params.status = patch.status;
  }
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Enregistre un numéro EN ATTENTE de vérification : il n'est reconnu comme
 * identité WhatsApp qu'après le premier message reçu depuis ce numéro.
 */
export function setPendingPhone(id: string, input: string, db: Db = getDb()): UserRow {
  const phone = normalizePhone(input);
  if (!phone) throw new EmaError("VALIDATION", "Numéro de téléphone invalide (format attendu : +33 6 12 34 56 78)");
  const other = getUserByPhone(phone, db);
  if (other && other.id !== id) throw new EmaError("CONFLICT", "Ce numéro est déjà associé à un autre compte EMA");
  db.prepare("UPDATE users SET phone_number = ?, phone_verified = 0, whatsapp_enabled = 0, verified_at = NULL, updated_at = ? WHERE id = ?").run(phone, nowIso(), id);
  return getUser(id, db) as UserRow;
}

/** Premier message reçu depuis le numéro en attente : association définitive. */
export function markPhoneVerified(id: string, db: Db = getDb()): UserRow {
  const now = nowIso();
  db.prepare("UPDATE users SET phone_verified = 1, whatsapp_enabled = 1, verified_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  return getUser(id, db) as UserRow;
}

/** Désactivation par l'utilisateur : le numéro est retiré, EMA ne répond plus. */
export function clearPhone(id: string, db: Db = getDb()): UserRow {
  db.prepare("UPDATE users SET phone_number = NULL, phone_verified = 0, whatsapp_enabled = 0, verified_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
  return getUser(id, db) as UserRow;
}

/**
 * Numéro WhatsApp (chiffres, sans « + ») auquel EMA peut écrire pour cet
 * utilisateur : uniquement s'il est vérifié et activé. Sinon null.
 */
export function whatsappRecipientFor(userId: string | null | undefined, db: Db = getDb()): string | null {
  if (!userId) return null;
  const u = getUser(userId, db);
  if (!u || u.status !== "active" || !u.phone_number || u.phone_verified !== 1 || u.whatsapp_enabled !== 1) return null;
  return u.phone_number.replace(/^\+/, "");
}

/** Vue sûre pour l'interface et les journaux : jamais le hash. */
export function publicUser(u: UserRow): { id: string; email: string; name: string | null; role: UserRole; phoneNumber: string | null; phoneVerified: boolean; whatsappEnabled: boolean; verifiedAt: string | null; createdAt: string } {
  return { id: u.id, email: u.email, name: u.name, role: u.role, phoneNumber: u.phone_number, phoneVerified: u.phone_verified === 1, whatsappEnabled: u.whatsapp_enabled === 1, verifiedAt: u.verified_at, createdAt: u.created_at };
}
