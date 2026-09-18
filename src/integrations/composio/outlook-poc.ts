import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { logHistory } from "@/database/repositories/history";
import { deleteComposioConnection, getComposioConnection, updateComposioConnection, upsertComposioConnection, type ComposioConnectionRow } from "@/database/repositories/composio-connections";
import type { UserRow } from "@/database/types";
import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { ComposioError, createComposioClient, type ComposioClient, type ComposioTool } from "./client";
import { assertReadOnlySlug, classifyTools, POC_TOOLKIT, resolveOperation, type ReadOperation } from "./policy";

/**
 * POC « Outlook via Composio » — lecture seule, isolé du reste d'EMA.
 *
 * - Actif uniquement si COMPOSIO_POC_ENABLED=true ; sinon EMA ignore ce module.
 * - Chaque connexion appartient à UN utilisateur EMA : l'identifiant externe
 *   transmis à Composio est `user.id` (stable, non ambigu) et chaque exécution
 *   exige à la fois `connected_account_id` (issu de la ligne de cet utilisateur)
 *   et `user_id`. Aucune connexion globale.
 * - Aucun token Microsoft n'est copié : seules des références sont stockées.
 * - Les tools exécutables passent par `resolveOperation` + `assertReadOnlySlug`
 *   (fail-closed) ; aucun endpoint n'exécute un slug fourni par le client.
 */
const log = createLogger("composio.poc");
const TOOLS_CACHE_TTL_MS = 10 * 60_000;

export type PocUiStatus = "disconnected" | "connecting" | "connected" | "error" | "reconnect_required";

export interface PocDeps {
  db?: Db;
  client?: ComposioClient;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface PocState {
  enabled: boolean;
  configured: boolean;
  configError: string | null;
  status: PocUiStatus;
  accountEmail: string | null;
  connectedAccountId: string | null;
  statusReason: string | null;
  requestedScopes: string[];
  /** Scopes d'écriture détectés dans les scopes demandés : à corriger dans l'auth config Composio. */
  writeScopesDetected: string[];
  lastError: string | null;
  lastCheckedAt: string | null;
  adminApprovalRequired: boolean;
}

const WRITE_SCOPE = /(ReadWrite|\.Send|\.Write|Mail\.Send|Calendars\.ReadWrite|Files\.ReadWrite)/i;
const ADMIN_APPROVAL = /(admin|consent_required|AADSTS65001|AADSTS90094|AADSTS650052|approval)/i;

let toolsCache: { at: number; tools: ComposioTool[] } | null = null;

export function resetComposioPocForTests(): void {
  toolsCache = null;
}

export function isComposioPocEnabled(): boolean {
  return getEnv().COMPOSIO_POC_ENABLED;
}

function resolve(deps: PocDeps): { db: Db; client: ComposioClient; now: Date } {
  if (!isComposioPocEnabled()) throw new EmaError("CONFIG", "POC Composio désactivé (COMPOSIO_POC_ENABLED=false)");
  return { db: deps.db ?? getDb(), client: deps.client ?? createComposioClient(deps.fetchImpl), now: deps.now ? deps.now() : new Date() };
}

function uiStatus(row: ComposioConnectionRow | undefined): PocUiStatus {
  if (!row) return "disconnected";
  switch (row.status) {
    case "ACTIVE":
      return "connected";
    case "INITIALIZING":
    case "INITIATED":
      return "connecting";
    case "EXPIRED":
    case "REVOKED":
    case "INACTIVE":
      return "reconnect_required";
    default:
      return "error";
  }
}

/** État affiché dans l'interface : jamais de secret. */
export function getPocState(user: UserRow, db: Db = getDb()): PocState {
  const env = getEnv();
  const enabled = env.COMPOSIO_POC_ENABLED;
  const configured = enabled && Boolean(env.COMPOSIO_API_KEY);
  const row = enabled ? getComposioConnection(user.id, db) : undefined;
  const scopes = row ? (JSON.parse(row.requested_scopes) as string[]) : [];
  return {
    enabled,
    configured,
    configError: !enabled ? "COMPOSIO_POC_ENABLED=false" : !env.COMPOSIO_API_KEY ? "COMPOSIO_API_KEY absente dans .env" : null,
    status: uiStatus(row),
    accountEmail: row?.account_email ?? null,
    connectedAccountId: row?.connected_account_id ?? null,
    statusReason: row?.status_reason ?? null,
    requestedScopes: scopes,
    writeScopesDetected: scopes.filter((s) => WRITE_SCOPE.test(s)),
    lastError: row?.last_error ?? null,
    lastCheckedAt: row?.last_checked_at ?? null,
    adminApprovalRequired: ADMIN_APPROVAL.test(`${row?.status_reason ?? ""} ${row?.last_error ?? ""}`),
  };
}

/** Auth config Outlook : variable d'environnement, sinon l'unique auth config Outlook du projet Composio. */
async function resolveAuthConfigId(client: ComposioClient): Promise<string> {
  const fromEnv = getEnv().COMPOSIO_OUTLOOK_AUTH_CONFIG_ID;
  if (fromEnv) return fromEnv;
  const configs = (await client.listAuthConfigs(POC_TOOLKIT)).filter((c) => c.toolkit === POC_TOOLKIT || c.toolkit === "");
  if (configs.length === 1 && configs[0]) return configs[0].id;
  if (configs.length === 0) throw new EmaError("CONFIG", "Aucune auth config Outlook dans le projet Composio : créez-la dans le tableau de bord Composio (scopes lecture seule) puis renseignez COMPOSIO_OUTLOOK_AUTH_CONFIG_ID");
  throw new EmaError("CONFIG", `Plusieurs auth configs Outlook (${configs.map((c) => c.id).join(", ")}) : renseignez COMPOSIO_OUTLOOK_AUTH_CONFIG_ID`);
}

/** Démarre le parcours OAuth Composio/Microsoft pour l'utilisateur connecté. */
export async function startComposioConnection(user: UserRow, callbackUrl: string, deps: PocDeps = {}): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const { db, client } = resolve(deps);
  const existing = getComposioConnection(user.id, db);
  // Reconnexion : l'ancien compte est supprimé côté Composio avant d'en créer un nouveau.
  if (existing) {
    try {
      await client.deleteAccount(existing.connected_account_id);
    } catch (err) {
      if (!(err instanceof ComposioError && err.httpStatus === 404)) log.warn("previous composio account not deleted", { userId: user.id, message: err instanceof Error ? err.message : String(err) });
    }
    deleteComposioConnection(user.id, db);
  }
  const authConfigId = await resolveAuthConfigId(client);
  const link = await client.createLink({ authConfigId, userId: user.id, callbackUrl });
  upsertComposioConnection({ userId: user.id, connectedAccountId: link.connectedAccountId, authConfigId, status: "INITIATED" }, db);
  logHistory({ eventType: "composio.connect_started", message: "Connexion Outlook via Composio démarrée (POC)", actor: "user", userId: user.id }, db);
  log.info("composio link created", { userId: user.id, connectedAccountId: link.connectedAccountId });
  return { redirectUrl: link.redirectUrl, connectedAccountId: link.connectedAccountId };
}

/** Relit le statut chez Composio et le mémorise. Vérifie que le compte appartient bien à cet utilisateur. */
export async function refreshComposioConnection(user: UserRow, deps: PocDeps = {}): Promise<PocState> {
  const { db, client } = resolve(deps);
  const row = getComposioConnection(user.id, db);
  if (!row) return getPocState(user, db);
  try {
    const account = await client.getAccount(row.connected_account_id);
    if (account.userId && account.userId !== user.id) {
      // Ne doit jamais arriver : la référence pointe vers le compte d'un autre utilisateur externe.
      log.error("composio account owner mismatch: reference dropped", { userId: user.id });
      deleteComposioConnection(user.id, db);
      throw new EmaError("FORBIDDEN", "Le compte Composio référencé n'appartient pas à cet utilisateur : référence supprimée");
    }
    updateComposioConnection(user.id, { status: account.status, statusReason: account.statusReason, requestedScopes: account.requestedScopes, lastError: null, checked: true }, db);
    if (account.status === "ACTIVE" && !row.account_email) {
      const email = await fetchAccountEmail(user, { ...deps, db, client });
      if (email) updateComposioConnection(user.id, { accountEmail: email }, db);
    }
    log.info("composio status refreshed", { userId: user.id, status: account.status });
  } catch (err) {
    if (err instanceof ComposioError && err.httpStatus === 404) {
      updateComposioConnection(user.id, { status: "REVOKED", statusReason: "Compte connecté introuvable chez Composio", lastError: null, checked: true }, db);
    } else if (err instanceof EmaError && err.code === "FORBIDDEN") {
      throw err;
    } else {
      updateComposioConnection(user.id, { lastError: err instanceof Error ? err.message : String(err), checked: true }, db);
    }
  }
  return getPocState(user, db);
}

/** Déconnexion : suppression + révocation côté Composio, puis oubli de la référence. */
export async function disconnectComposio(user: UserRow, deps: PocDeps = {}): Promise<PocState> {
  const { db, client } = resolve(deps);
  const row = getComposioConnection(user.id, db);
  if (row) {
    try {
      await client.deleteAccount(row.connected_account_id);
    } catch (err) {
      if (!(err instanceof ComposioError && err.httpStatus === 404)) throw err;
    }
    deleteComposioConnection(user.id, db);
    logHistory({ eventType: "composio.disconnected", message: "Outlook via Composio déconnecté (POC)", actor: "user", userId: user.id }, db);
  }
  return getPocState(user, db);
}

/* Lecture seule --------------------------------------------------------------- */

async function loadTools(client: ComposioClient, now: Date): Promise<ComposioTool[]> {
  if (toolsCache && now.getTime() - toolsCache.at < TOOLS_CACHE_TTL_MS) return toolsCache.tools;
  const tools = await client.listTools(POC_TOOLKIT);
  toolsCache = { at: now.getTime(), tools };
  return tools;
}

/** Tools du toolkit, classés par la politique (diagnostic). */
export async function listPocTools(deps: PocDeps = {}): Promise<{ allowed: ComposioTool[]; blocked: ComposioTool[] }> {
  const { client, now } = resolve(deps);
  return classifyTools(await loadTools(client, now));
}

/** Arguments canoniques du POC → noms de paramètres réellement déclarés par le tool. */
const ARGUMENT_ALIASES: Record<string, string[]> = {
  limit: ["top", "limit", "max_results", "maxResults", "page_size", "count", "num_results"],
  query: ["search", "query", "q", "search_query", "keyword", "filter"],
  message_id: ["message_id", "messageId", "id", "email_id", "mail_id"],
  attachment_id: ["attachment_id", "attachmentId"],
  start: ["start_datetime", "startDateTime", "start", "start_date", "from_datetime", "time_min"],
  end: ["end_datetime", "endDateTime", "end", "end_date", "to_datetime", "time_max"],
};

export function shapeArguments(tool: ComposioTool, canonical: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const declared = new Set(tool.inputParameters);
  for (const [key, value] of Object.entries(canonical)) {
    if (value === undefined || value === null || value === "") continue;
    const names = ARGUMENT_ALIASES[key] ?? [key];
    const target = names.find((n) => declared.has(n)) ?? (declared.size === 0 ? names[0] : undefined);
    if (target) out[target] = value;
  }
  return out;
}

const MAX_OUTPUT_CHARS = 60_000;

/** Retire tout contenu binaire volumineux (pièces jointes) : le POC n'affiche que des métadonnées. */
function stripBinary(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => stripBinary(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(contentBytes|content_bytes|base64|data_base64|bytes)$/i.test(k) && typeof v === "string") out[k] = `[contenu binaire de ${v.length} caractères non affiché]`;
      else if (typeof v === "string" && v.length > 8_000) out[k] = `${v.slice(0, 8_000)}… [tronqué]`;
      else out[k] = stripBinary(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface ReadResult {
  ok: boolean;
  operation: ReadOperation;
  tool: string;
  arguments: Record<string, unknown>;
  data: unknown;
  error: string | null;
}

/**
 * Exécute une opération de LECTURE pour l'utilisateur donné, avec SA connexion.
 * Aucun slug n'est accepté de l'extérieur : seule l'opération l'est.
 */
export async function runPocRead(user: UserRow, operation: ReadOperation, canonical: Record<string, unknown>, deps: PocDeps = {}): Promise<ReadResult> {
  const { db, client, now } = resolve(deps);
  const row = getComposioConnection(user.id, db);
  if (!row) throw new EmaError("MICROSOFT_RECONNECT", "Outlook via Composio n'est pas connecté pour ce compte");
  if (row.status !== "ACTIVE") throw new EmaError("MICROSOFT_RECONNECT", `Connexion Composio non active (${row.status}) : reconnectez Outlook via Composio`);

  const tools = await loadTools(client, now);
  const tool = resolveOperation(operation, tools);
  assertReadOnlySlug(tool.slug, tools); // second rempart, fail-closed
  const args = shapeArguments(tool, canonical);
  log.info("composio read", { userId: user.id, operation, tool: tool.slug, args: Object.keys(args) });
  const result = await client.execute(tool.slug, { connectedAccountId: row.connected_account_id, userId: user.id, arguments: args });
  if (!result.successful) {
    const message = result.error ?? "Échec sans message";
    if (/(unauthorized|401|invalid_grant|token|expired|revoked|consent)/i.test(message)) {
      updateComposioConnection(user.id, { status: "EXPIRED", statusReason: message.slice(0, 200), checked: true }, db);
    }
    log.warn("composio read failed", { userId: user.id, operation, tool: tool.slug });
    return { ok: false, operation, tool: tool.slug, arguments: args, data: null, error: message.slice(0, 500) };
  }
  const data = stripBinary(result.data);
  const serialized = JSON.stringify(data);
  return { ok: true, operation, tool: tool.slug, arguments: args, data: serialized.length > MAX_OUTPUT_CHARS ? { truncated: true, preview: serialized.slice(0, MAX_OUTPUT_CHARS) } : data, error: null };
}

/** Adresse du compte Outlook connecté, via un tool de profil en lecture (best effort). */
async function fetchAccountEmail(user: UserRow, deps: PocDeps): Promise<string | null> {
  try {
    const r = await runPocRead(user, "get_profile", {}, deps);
    if (!r.ok) return null;
    return findEmail(r.data);
  } catch (err) {
    log.debug("profile lookup unavailable", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Cherche une adresse email plausible dans la réponse d'un tool de profil. */
export function findEmail(value: unknown, depth = 0): string | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of ["mail", "email", "userPrincipalName", "emailAddress", "user_principal_name", "address"]) {
    const v = obj[key];
    if (typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    const found = findEmail(v, depth + 1);
    if (found) return found;
  }
  return null;
}
