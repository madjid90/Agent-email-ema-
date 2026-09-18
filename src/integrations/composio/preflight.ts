import { getDb, type Db } from "@/database/connection";
import { migrationStatus } from "@/database/migrate";
import { checkEnv, getEnv } from "@/lib/env";
import { GRAPH_SCOPES } from "@/integrations/microsoft/oauth";
import { isComposioPocEnabled, resolveCallbackMode, type CallbackMode } from "./outlook-poc";
import { ALLOWED_SLUGS, OPERATION_TOOLS, POC_READ_ONLY_SCOPES, POC_TOOLKIT, WRITE_VERBS } from "./policy";

/**
 * Preflight du POC Composio : état / configuration UNIQUEMENT, jamais une
 * valeur secrète. Chaque variable sensible est réduite à « présente / absente ».
 * Réservé à un utilisateur authentifié (route `/api/poc/composio/preflight`).
 */
export type PreflightLevel = "OK" | "WARN" | "FAIL";

export interface PreflightCheck {
  key: string;
  label: string;
  level: PreflightLevel;
  /** Détail lisible : jamais une clé, un token, un secret ni une adresse de compte. */
  detail: string;
}

/** Capacités du POC, toutes en lecture ; rien d'autre n'existe. */
export const POC_CAPABILITIES = ["email.read", "email.search", "attachment.read", "calendar.read"] as const;

export interface PreflightReport {
  ready: boolean;
  checks: PreflightCheck[];
  callbackMode: CallbackMode | null;
  baseUrl: string;
  expectedExecutableTools: number;
  capabilities: readonly string[];
  readOnlyScopes: readonly string[];
}

const COMPOSIO_MIGRATION = "011_composio_poc";

function presence(key: string, label: string, present: boolean, missing: string, ok = "présente"): PreflightCheck {
  return { key, label, level: present ? "OK" : "FAIL", detail: present ? ok : missing };
}

/** Le POC ne doit jamais avoir touché à Microsoft Graph natif : mêmes scopes délégués, mêmes exports. */
export function nativeGraphIntact(): { intact: boolean; detail: string } {
  const expected = ["openid", "profile", "offline_access", "User.Read", "Mail.Read", "Mail.Send"];
  const actual = [...GRAPH_SCOPES];
  const intact = actual.length === expected.length && actual.every((s, i) => s === expected[i]);
  return { intact, detail: intact ? `scopes délégués inchangés (${actual.join(" ")}), aucune dépendance du POC` : `scopes délégués modifiés : ${actual.join(" ")}` };
}

function dbCheck(db: Db | null): { accessible: boolean; migrationApplied: boolean; tableExists: boolean } {
  if (!db) return { accessible: false, migrationApplied: false, tableExists: false };
  try {
    db.prepare("SELECT 1").get();
    const applied = migrationStatus(db).some((m) => m.name === COMPOSIO_MIGRATION && m.applied);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'composio_connections'").get() as { name: string } | undefined;
    return { accessible: true, migrationApplied: applied, tableExists: Boolean(table) };
  } catch {
    return { accessible: false, migrationApplied: false, tableExists: false };
  }
}

/** Nombre de slugs de la table déterministe (les seuls exécutables), sans aucun verbe d'écriture. */
export function expectedExecutableToolCount(): number {
  const slugs = [...ALLOWED_SLUGS];
  if (slugs.some((s) => WRITE_VERBS.test(s))) throw new Error("La table OPERATION_TOOLS contient un verbe d'écriture");
  return slugs.length;
}

export function runComposioPreflight(opts: { db?: Db | null } = {}): PreflightReport {
  const env = getEnv();
  const checks: PreflightCheck[] = [];
  const enabled = isComposioPocEnabled();

  checks.push({ key: "poc_enabled", label: "POC activé (COMPOSIO_POC_ENABLED)", level: enabled ? "OK" : "FAIL", detail: enabled ? "configuré : true" : "absent ou false : le POC est invisible (404)" });
  checks.push(presence("api_key", "COMPOSIO_API_KEY", Boolean(env.COMPOSIO_API_KEY), "absente dans .env"));
  checks.push({ key: "auth_config_id", label: "COMPOSIO_OUTLOOK_AUTH_CONFIG_ID", level: env.COMPOSIO_OUTLOOK_AUTH_CONFIG_ID ? "OK" : "WARN", detail: env.COMPOSIO_OUTLOOK_AUTH_CONFIG_ID ? "présent" : "absent : découverte automatique uniquement si une seule auth config Outlook existe (recommandé : le renseigner)" });

  let callbackMode: CallbackMode | null = null;
  try {
    callbackMode = resolveCallbackMode();
    checks.push({ key: "callback_mode", label: "Mode de retour OAuth", level: callbackMode === "verified" ? "OK" : "WARN", detail: callbackMode === "verified" ? "verified (Callback Identity Verification)" : "local : toléré hors production uniquement, lien à garder privé" });
    checks.push({ key: "production_safety", label: "Sécurité production", level: "OK", detail: env.NODE_ENV === "production" ? "production avec vérification d'identité" : `hors production (NODE_ENV=${env.NODE_ENV})` });
  } catch (err) {
    checks.push({ key: "callback_mode", label: "Mode de retour OAuth", level: "FAIL", detail: "indéterminé : configuration refusée" });
    checks.push({ key: "production_safety", label: "Sécurité production", level: "FAIL", detail: err instanceof Error ? err.message : String(err) });
  }

  const appUrl = env.APP_URL.replace(/\/+$/, "");
  const appUrlOk = /^https?:\/\/[^\s/]+/.test(appUrl) && (env.NODE_ENV !== "production" || appUrl.startsWith("https://"));
  checks.push({ key: "app_url", label: "APP_URL", level: appUrlOk ? "OK" : "FAIL", detail: appUrlOk ? `${appUrl} (callback : ${appUrl}/api/poc/composio/callback)` : `invalide ou non HTTPS en production : ${appUrl}` });

  const baseUrl = env.COMPOSIO_BASE_URL.replace(/\/+$/, "");
  const baseOk = baseUrl.startsWith("https://");
  checks.push({ key: "base_url", label: "URL de base Composio", level: baseOk ? "OK" : "FAIL", detail: baseOk ? baseUrl : `${baseUrl} : HTTPS obligatoire` });

  const db = opts.db === undefined ? safeDb() : opts.db;
  const d = dbCheck(db);
  checks.push({ key: "db", label: "Base SQLite accessible", level: d.accessible ? "OK" : "FAIL", detail: d.accessible ? "SELECT 1 réussi" : "base inaccessible" });
  checks.push({ key: "migration", label: `Migration ${COMPOSIO_MIGRATION}`, level: d.migrationApplied && d.tableExists ? "OK" : "FAIL", detail: d.migrationApplied && d.tableExists ? "appliquée, table composio_connections présente" : "non appliquée : exécuter npm run db:migrate" });

  const graph = nativeGraphIntact();
  checks.push({ key: "native_graph", label: "Microsoft Graph natif intact", level: graph.intact ? "OK" : "FAIL", detail: graph.detail });

  const blocking = checkEnv(env).filter((i) => i.level === "error");
  checks.push({ key: "env_blocking", label: "Configuration EMA bloquante", level: blocking.length === 0 ? "OK" : "FAIL", detail: blocking.length === 0 ? "aucune erreur bloquante" : blocking.map((i) => i.variable).join(", ") });

  const expected = expectedExecutableToolCount();
  checks.push({ key: "executable_tools", label: "Tools Outlook exécutables attendus", level: "OK", detail: `${expected} slugs ${POC_TOOLKIT.toUpperCase()}_* (${Object.keys(OPERATION_TOOLS).length} opérations de lecture)` });
  checks.push({ key: "capabilities", label: "Capacités autorisées", level: "OK", detail: POC_CAPABILITIES.join(", ") });

  return { ready: checks.every((c) => c.level !== "FAIL"), checks, callbackMode, baseUrl, expectedExecutableTools: expected, capabilities: POC_CAPABILITIES, readOnlyScopes: POC_READ_ONLY_SCOPES };
}

function safeDb(): Db | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}
