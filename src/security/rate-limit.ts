import { createLogger } from "@/lib/logger";

/**
 * Limitation de débit minimaliste, en mémoire du process (aucune infrastructure
 * externe). Utilisée pour le formulaire de connexion : EMA est mono-utilisateur
 * derrière Nginx, un compteur local suffit à casser un bruteforce.
 */
const log = createLogger("security.rate-limit");

interface Bucket {
  hits: number[];
  blockedUntil: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Nombre de tentatives autorisées dans la fenêtre. */
  max: number;
  /** Fenêtre glissante, en millisecondes. */
  windowMs: number;
  /** Durée de blocage après dépassement. */
  blockMs: number;
}

export const LOGIN_RATE_LIMIT: RateLimitOptions = { max: 8, windowMs: 10 * 60_000, blockMs: 15 * 60_000 };

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** Enregistre une tentative et indique si elle est autorisée. */
export function hitRateLimit(key: string, opts: RateLimitOptions = LOGIN_RATE_LIMIT, now: number = Date.now()): RateLimitResult {
  const bucket = buckets.get(key) ?? { hits: [], blockedUntil: 0 };
  if (bucket.blockedUntil > now) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000) };
  }
  bucket.hits = bucket.hits.filter((t) => now - t < opts.windowMs);
  bucket.hits.push(now);
  if (bucket.hits.length > opts.max) {
    bucket.blockedUntil = now + opts.blockMs;
    bucket.hits = [];
    buckets.set(key, bucket);
    log.warn("rate limit reached", { key, blockSeconds: Math.round(opts.blockMs / 1000) });
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(opts.blockMs / 1000) };
  }
  buckets.set(key, bucket);
  return { allowed: true, remaining: Math.max(0, opts.max - bucket.hits.length), retryAfterSeconds: 0 };
}

/** Réinitialise le compteur (connexion réussie). */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

export function clearRateLimits(): void {
  buckets.clear();
}

/** Identifiant de client : IP transmise par Nginx, sinon adresse de secours. */
export function clientKey(req: Request, prefix = "login"): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  return `${prefix}:${ip}`;
}
