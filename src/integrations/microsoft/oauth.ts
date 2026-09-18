import { randomBytes } from "node:crypto";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { kvGet, kvSet } from "@/database/repositories/kv";
import { logHistory } from "@/database/repositories/history";
import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { nowIso } from "@/lib/ids";
import { clearTokenSet, loadTokenSet, saveTokenSet } from "./token-store";
import type { TokenSet } from "./types";

const log = createLogger("microsoft.oauth");

/**
 * Permissions déléguées Microsoft Graph, strictement nécessaires :
 * - offline_access : obtenir un refresh token (autorisation durable)
 * - User.Read      : GET /me (adresse de la mailbox connectée)
 * - Mail.Read      : lire messages, conversations, pièces jointes, delta, recherche
 * - Mail.Send      : reply / forward / sendMail
 * Pas de Mail.ReadWrite : EMA ne modifie, ne déplace et ne supprime aucun email.
 */
export const GRAPH_SCOPES = ["openid", "profile", "offline_access", "User.Read", "Mail.Read", "Mail.Send"] as const;

const STATE_KEY = "outlook.oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthDeps {
  db?: Db;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Utilisateur qui connecte SA boîte (session serveur). null : instance mono-utilisateur historique. */
  userId?: string | null;
}

/** Clé de l'état anti-CSRF : une par état, plusieurs utilisateurs peuvent se connecter en parallèle. */
function stateKey(state: string): string {
  return `${STATE_KEY}:${state}`;
}

function authority(): string {
  return `https://login.microsoftonline.com/${getEnv().MICROSOFT_TENANT_ID}/oauth2/v2.0`;
}

function credentials(): { clientId: string; clientSecret: string; redirectUri: string } {
  const env = getEnv();
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET || !env.MICROSOFT_REDIRECT_URI) {
    throw new EmaError("CONFIG", "Variables MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_REDIRECT_URI manquantes");
  }
  return { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, redirectUri: env.MICROSOFT_REDIRECT_URI };
}

/* État anti-CSRF ---------------------------------------------------------- */

export function createOAuthState(deps: OAuthDeps = {}): string {
  const db = deps.db ?? getDb();
  const state = randomBytes(24).toString("base64url");
  kvSet(stateKey(state), JSON.stringify({ state, userId: deps.userId ?? null, createdAt: (deps.now ?? Date.now)() }), db);
  return state;
}

/**
 * Vérifie et consomme l'état (usage unique, 10 minutes). Renvoie l'utilisateur
 * qui a lancé le flux : c'est lui, et lui seul, qui reçoit la connexion — le
 * callback Microsoft ne fait confiance ni à un cookie ni à un paramètre libre.
 */
export function consumeOAuthState(candidate: string, deps: OAuthDeps = {}): { ok: true; userId: string | null } | { ok: false } {
  const db = deps.db ?? getDb();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(candidate)) return { ok: false };
  const raw = kvGet(stateKey(candidate), db);
  db.prepare("DELETE FROM settings_kv WHERE key = ?").run(stateKey(candidate));
  if (!raw) return { ok: false };
  let parsed: { state?: string; userId?: string | null; createdAt?: number };
  try {
    parsed = JSON.parse(raw) as { state?: string; userId?: string | null; createdAt?: number };
  } catch {
    return { ok: false };
  }
  if (!parsed.state || parsed.state !== candidate) return { ok: false };
  if (!parsed.createdAt || (deps.now ?? Date.now)() - parsed.createdAt > STATE_TTL_MS) return { ok: false };
  return { ok: true, userId: parsed.userId ?? null };
}

/* Flux authorization code -------------------------------------------------- */

export function buildAuthorizeUrl(state: string): string {
  const { clientId, redirectUri } = credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: GRAPH_SCOPES.join(" "),
    state,
    prompt: "select_account",
  });
  return `${authority()}/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>, deps: OAuthDeps): Promise<TokenSet> {
  const { clientId, clientSecret, redirectUri } = credentials();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, scope: GRAPH_SCOPES.join(" "), ...params });
  let res: Response;
  try {
    res = await fetchImpl(`${authority()}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  } catch (err) {
    throw new EmaError("INTEGRATION", "Impossible de joindre le service d'authentification Microsoft", { cause: err });
  }
  let json: TokenResponse = {};
  try {
    json = (await res.json()) as TokenResponse;
  } catch {
    /* corps vide ou non JSON */
  }
  if (!res.ok || !json.access_token) {
    const code = json.error ?? `http_${res.status}`;
    log.warn("token request failed", { code });
    throw new EmaError("INTEGRATION", `Authentification Microsoft refusée (${code})`, { details: { code } });
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    // Microsoft peut ne pas renvoyer de nouveau refresh token : conserver l'ancien.
    refreshToken: json.refresh_token ?? params.refresh_token ?? "",
    expiresAt: new Date((deps.now ?? Date.now)() + expiresIn * 1000).toISOString(),
    scope: json.scope ?? GRAPH_SCOPES.join(" "),
  };
}

export async function exchangeCodeForTokens(code: string, deps: OAuthDeps = {}): Promise<TokenSet> {
  const set = await tokenRequest({ grant_type: "authorization_code", code }, deps);
  if (!set.refreshToken) throw new EmaError("INTEGRATION", "Aucun refresh token reçu : vérifier la permission offline_access");
  return set;
}

export async function refreshTokenSet(refreshToken: string, deps: OAuthDeps = {}): Promise<TokenSet> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, deps);
}

/**
 * Fin du flux : échange du code, récupération de l'adresse (/me), stockage chiffré.
 * `fetchMe` est injecté pour éviter une dépendance circulaire avec graph-client.
 */
export async function completeConnection(
  input: { code: string; state: string },
  fetchMe: (accessToken: string) => Promise<{ email: string | null; displayName: string | null }>,
  deps: OAuthDeps = {},
): Promise<{ accountEmail: string | null; userId: string | null }> {
  const db = deps.db ?? getDb();
  const state = consumeOAuthState(input.state, deps);
  if (!state.ok) throw new EmaError("FORBIDDEN", "État OAuth invalide ou expiré : relancer la connexion");
  const userId = state.userId;
  const set = await exchangeCodeForTokens(input.code, deps);
  const me = await fetchMe(set.accessToken);
  saveTokenSet(set, me.email, db, userId);
  kvSet(userId ? `outlook.connected_at:${userId}` : "outlook.connected_at", nowIso(), db);
  logHistory({ eventType: "outlook.connected", message: `Outlook connecté : ${me.email ?? "adresse inconnue"}`, actor: "user", userId }, db);
  log.info("outlook connected", { userId, account: me.email });
  return { accountEmail: me.email, userId };
}

export function disconnect(deps: OAuthDeps = {}): void {
  const db = deps.db ?? getDb();
  const existing = loadTokenSet(db, deps.userId);
  if (!existing) return;
  clearTokenSet(db, existing.userId);
  kvSet(existing.userId ? `outlook.sync_cursor:${existing.userId}` : "outlook.sync_cursor", "", db);
  logHistory({ eventType: "outlook.disconnected", message: `Outlook déconnecté${existing.accountEmail ? ` (${existing.accountEmail})` : ""}`, actor: "user", userId: existing.userId }, db);
}
