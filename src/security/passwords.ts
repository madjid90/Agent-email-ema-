import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Hachage des mots de passe utilisateur : scrypt (Node natif), sel aléatoire,
 * comparaison en temps constant. Format stocké : `scrypt$<sel b64>$<hash b64>`.
 */
const KEY_BYTES = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };
export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_BYTES, PARAMS);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPasswordHash(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const candidate = scryptSync(password, Buffer.from(salt, "base64"), expected.length, PARAMS);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
