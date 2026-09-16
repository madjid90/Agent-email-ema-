import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { getEnv } from "@/lib/env";
import { nowIso } from "@/lib/ids";
import { createLogger } from "@/lib/logger";

/**
 * Limitation de débit persistée en SQLite (phase 8A) : elle survit à un
 * redémarrage du process, contrairement à un compteur en mémoire. Aucun service
 * externe. Utilisée pour le formulaire de connexion.
 */
const log = createLogger("security.rate-limit");

export interface RateLimitOptions {
  /** Tentatives autorisées dans la fenêtre. */
  max: number;
  /** Fenêtre glissante (ms). */
  windowMs: number;
  /** Durée de blocage après dépassement (ms). */
  blockMs: number;
}

export const LOGIN_RATE_LIMIT: RateLimitOptions = { max: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 };

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface RateRow {
  key: string;
  hits: number;
  window_start: string;
  blocked_until: string | null;
}

/**
 * Enregistre une tentative. Le compteur ne repart qu'après la fenêtre ; au-delà
 * du maximum, l'accès est bloqué pour `blockMs`. Aucun mot de passe, aucune
 * empreinte n'est stocké — seulement une clé de regroupement et un compteur.
 */
export function hitRateLimit(key: string, opts: RateLimitOptions = LOGIN_RATE_LIMIT, now: number = Date.now(), db: Db = getDb()): RateLimitResult {
  const nowMs = now;
  const row = db.prepare("SELECT key, hits, window_start, blocked_until FROM rate_limits WHERE key = ?").get(key) as RateRow | undefined;

  if (row?.blocked_until && new Date(row.blocked_until).getTime() > nowMs) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((new Date(row.blocked_until).getTime() - nowMs) / 1000) };
  }
  const windowStart = row ? new Date(row.window_start).getTime() : 0;
  const inWindow = row !== undefined && nowMs - windowStart < opts.windowMs && !row.blocked_until;
  const hits = (inWindow ? row.hits : 0) + 1;
  const start = inWindow ? row.window_start : new Date(nowMs).toISOString();

  if (hits > opts.max) {
    const blockedUntil = new Date(nowMs + opts.blockMs).toISOString();
    upsert(db, { key, hits: 0, window_start: new Date(nowMs).toISOString(), blocked_until: blockedUntil });
    log.warn("rate limit reached", { key, blockSeconds: Math.round(opts.blockMs / 1000) });
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(opts.blockMs / 1000) };
  }
  upsert(db, { key, hits, window_start: start, blocked_until: null });
  return { allowed: true, remaining: Math.max(0, opts.max - hits), retryAfterSeconds: 0 };
}

function upsert(db: Db, row: RateRow): void {
  db.prepare(
    `INSERT INTO rate_limits (key, hits, window_start, blocked_until, updated_at) VALUES (@key, @hits, @window_start, @blocked_until, @updated_at)
     ON CONFLICT(key) DO UPDATE SET hits = excluded.hits, window_start = excluded.window_start, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`,
  ).run({ ...row, updated_at: nowIso() });
}

/** Réinitialise le compteur (connexion réussie). */
export function resetRateLimit(key: string, db: Db = getDb()): void {
  db.prepare("DELETE FROM rate_limits WHERE key = ?").run(key);
}

export function clearRateLimits(db: Db = getDb()): void {
  db.prepare("DELETE FROM rate_limits").run();
}

/**
 * Clé de regroupement. `X-Forwarded-For` n'est utilisé que si l'installation
 * garantit que Nginx le réécrit (`TRUST_PROXY_HEADER=true`) : sinon l'en-tête
 * est falsifiable et permettrait de contourner la limite en la changeant à
 * chaque essai — on retombe alors sur une clé globale, EMA étant mono-utilisateur.
 */
export function clientKey(req: Request, prefix = "login"): string {
  if (!getEnv().TRUST_PROXY_HEADER) return `${prefix}:global`;
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  return `${prefix}:${ip.slice(0, 45)}`;
}
