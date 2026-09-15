import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";

/**
 * Chiffrement AES-256-GCM des tokens OAuth avec une clé dérivée d'APP_SECRET.
 * Format : v1.<salt b64>.<iv b64>.<tag b64>.<ciphertext b64>
 */
const VERSION = "v1";

function appSecret(): string {
  const s = getEnv().APP_SECRET;
  if (!s || s.length < 32) throw new EmaError("CONFIG", "APP_SECRET manquant ou trop court (32 caractères minimum)");
  return s;
}

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(appSecret(), salt, 32);
}

export function encryptSecret(plain: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, salt.toString("base64"), iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new EmaError("INTERNAL", "Format de secret chiffré invalide");
  const [, saltB64, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
  const key = deriveKey(Buffer.from(saltB64, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new EmaError("INTERNAL", "Impossible de déchiffrer le secret (APP_SECRET a-t-il changé ?)", { cause: err });
  }
}

/** Signature HMAC-SHA256 (cookies de session, tokens de validation). */
export function hmacSign(payload: string, secret: string = appSecret()): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function hmacVerify(payload: string, signature: string, secret: string = appSecret()): boolean {
  const expected = Buffer.from(hmacSign(payload, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
