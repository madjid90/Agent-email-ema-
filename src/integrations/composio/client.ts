import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

/**
 * Client REST minimal pour l'API Composio v3.1 (POC Outlook).
 *
 * Pourquoi REST et non le SDK `@composio/core` : le SDK 0.18 exige Node
 * ≥ 22.22.3 (EMA : `engines >= 20.11`, VPS en 22.22.2) et tire `openai`,
 * `pusher-js` et `undici`. Le contrat ci-dessous est celui du client généré
 * `@composio/client` (Stainless) publié sur npm : en-tête `x-api-key`,
 * préfixe `/api/v3.1`.
 *
 * Règles : la clé ne quitte jamais ce module ; aucune réponse brute n'est
 * journalisée ; les comptes connectés sont ASSAINIS (Composio renvoie
 * `state.val.access_token` — jamais lu, jamais stocké, jamais renvoyé).
 */
const log = createLogger("composio.client");
const TIMEOUT_MS = 20_000;

export type ComposioStatus = "INITIALIZING" | "INITIATED" | "ACTIVE" | "FAILED" | "EXPIRED" | "INACTIVE" | "REVOKED";

/** Vue assainie d'un compte connecté : aucun secret, aucune donnée de connexion. */
export interface ComposioConnectedAccount {
  id: string;
  status: ComposioStatus;
  statusReason: string | null;
  toolkit: string | null;
  authConfigId: string | null;
  /** Identifiant externe (EMA user id) si Composio le renvoie encore (champ déprécié côté Composio). */
  userId: string | null;
  requestedScopes: string[];
  isDisabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ComposioTool {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  scopes: string[];
  tags: string[];
  deprecated: boolean;
  /** Noms des paramètres d'entrée déclarés (schéma JSON), pour adapter les arguments à l'exécution. */
  inputParameters: string[];
  requiredParameters: string[];
}

export interface ComposioExecuteResult {
  successful: boolean;
  data: Record<string, unknown>;
  error: string | null;
  logId: string | null;
}

export interface ComposioClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ComposioError extends EmaError {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null) {
    super("INTEGRATION", message, { status: 502, details: { httpStatus } });
    this.name = "ComposioError";
    this.httpStatus = httpStatus;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Ne conserve que les champs non sensibles d'un compte connecté. */
export function sanitizeAccount(raw: unknown): ComposioConnectedAccount {
  const r = (raw ?? {}) as Record<string, unknown>;
  const toolkit = r.toolkit as Record<string, unknown> | undefined;
  const authConfig = r.auth_config as Record<string, unknown> | undefined;
  return {
    id: str(r.id) ?? "",
    status: (str(r.status) as ComposioStatus | null) ?? "FAILED",
    statusReason: str(r.status_reason),
    toolkit: str(toolkit?.slug),
    authConfigId: str(authConfig?.id),
    userId: str(r.user_id),
    requestedScopes: strArray(r.requested_scopes),
    isDisabled: r.is_disabled === true,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function sanitizeTool(raw: unknown): ComposioTool {
  const r = (raw ?? {}) as Record<string, unknown>;
  const toolkit = r.toolkit as Record<string, unknown> | undefined;
  return {
    slug: (str(r.slug) ?? "").toUpperCase(),
    name: str(r.name) ?? "",
    description: (str(r.description) ?? "").slice(0, 300),
    toolkit: (str(toolkit?.slug) ?? "").toLowerCase(),
    scopes: strArray(r.scopes),
    tags: strArray(r.tags),
    deprecated: r.is_deprecated === true,
    inputParameters: Object.keys(((r.input_parameters as Record<string, unknown> | undefined)?.properties as Record<string, unknown> | undefined) ?? {}),
    requiredParameters: strArray((r.input_parameters as Record<string, unknown> | undefined)?.required),
  };
}

export class ComposioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ComposioClientOptions) {
    if (!opts.apiKey) throw new EmaError("CONFIG", "COMPOSIO_API_KEY absente");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.composio.dev").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Requête brute : jamais de clé dans les journaux, jamais de corps de réponse dans les journaux. */
  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, opts: { query?: Record<string, string | string[] | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v3.1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = { "x-api-key": this.apiKey, accept: "application/json" };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), init);
    } catch (err) {
      log.warn("composio unreachable", { path, message: err instanceof Error ? err.message : String(err) });
      throw new ComposioError("Composio injoignable", null);
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const body = (json ?? {}) as Record<string, unknown>;
      const err = body.error as Record<string, unknown> | string | undefined;
      const message = typeof err === "string" ? err : str(err?.message) ?? str(body.message) ?? `HTTP ${res.status}`;
      log.warn("composio request failed", { path, status: res.status, code: typeof err === "object" ? str(err?.code) : null });
      if (res.status === 401 || res.status === 403) throw new ComposioError("Composio a refusé la clé API (401/403) : vérifier COMPOSIO_API_KEY", res.status);
      if (res.status === 404) throw new ComposioError(`Ressource Composio introuvable : ${message.slice(0, 160)}`, 404);
      throw new ComposioError(`Composio a répondu ${res.status} : ${message.slice(0, 160)}`, res.status);
    }
    return json as T;
  }

  /* Auth configs ------------------------------------------------------------ */

  /** Auth configs d'un toolkit (identifiant et nom uniquement). */
  async listAuthConfigs(toolkitSlug: string): Promise<{ id: string; name: string; toolkit: string; isComposioManaged: boolean }[]> {
    const json = await this.request<{ items?: unknown[] }>("GET", "/auth_configs", { query: { toolkit_slug: toolkitSlug, limit: "50" } });
    return (json.items ?? []).map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const toolkit = r.toolkit as Record<string, unknown> | undefined;
      return { id: str(r.id) ?? "", name: str(r.name) ?? "", toolkit: (str(toolkit?.slug) ?? "").toLowerCase(), isComposioManaged: r.is_composio_managed === true };
    });
  }

  /* Comptes connectés ------------------------------------------------------- */

  /** Démarre le flux OAuth hébergé par Composio pour UN utilisateur externe. */
  async createLink(input: { authConfigId: string; userId: string; callbackUrl?: string }): Promise<{ connectedAccountId: string; redirectUrl: string; expiresAt: string | null }> {
    const json = await this.request<Record<string, unknown>>("POST", "/connected_accounts/link", {
      body: { auth_config_id: input.authConfigId, user_id: input.userId, ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}) },
    });
    const connectedAccountId = str(json.connected_account_id);
    const redirectUrl = str(json.redirect_url);
    if (!connectedAccountId || !redirectUrl) throw new ComposioError("Réponse Composio inattendue (lien de connexion sans identifiant ou sans URL)", null);
    return { connectedAccountId, redirectUrl, expiresAt: str(json.expires_at) };
  }

  async getAccount(connectedAccountId: string): Promise<ComposioConnectedAccount> {
    const raw = await this.request<unknown>("GET", `/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
    return sanitizeAccount(raw);
  }

  async listAccounts(input: { userId: string; toolkitSlug?: string }): Promise<ComposioConnectedAccount[]> {
    const json = await this.request<{ items?: unknown[] }>("GET", "/connected_accounts", { query: { user_ids: [input.userId], toolkit_slugs: input.toolkitSlug ? [input.toolkitSlug] : undefined, limit: "20" } });
    return (json.items ?? []).map(sanitizeAccount);
  }

  /** Suppression + révocation des identifiants côté fournisseur. */
  async deleteAccount(connectedAccountId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/connected_accounts/${encodeURIComponent(connectedAccountId)}`, { query: { revoke_on_delete: "true" } });
  }

  /* Tools ------------------------------------------------------------------- */

  async listTools(toolkitSlug: string): Promise<ComposioTool[]> {
    const out: ComposioTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const json = await this.request<{ items?: unknown[]; next_cursor?: string | null }>("GET", "/tools", { query: { toolkit_slug: toolkitSlug, limit: "100", cursor } });
      out.push(...(json.items ?? []).map(sanitizeTool));
      if (!json.next_cursor) break;
      cursor = json.next_cursor;
    }
    return out;
  }

  /** Exécute un tool pour un compte connecté ET un utilisateur donnés (les deux sont exigés). */
  async execute(slug: string, input: { connectedAccountId: string; userId: string; arguments: Record<string, unknown> }): Promise<ComposioExecuteResult> {
    const json = await this.request<Record<string, unknown>>("POST", `/tools/execute/${encodeURIComponent(slug)}`, {
      body: { connected_account_id: input.connectedAccountId, user_id: input.userId, arguments: input.arguments },
    });
    return {
      successful: json.successful === true,
      data: (json.data && typeof json.data === "object" ? json.data : {}) as Record<string, unknown>,
      error: str(json.error),
      logId: str(json.log_id),
    };
  }
}

/** Client relié à l'environnement ; lève CONFIG si la clé manque. */
export function createComposioClient(fetchImpl?: typeof fetch): ComposioClient {
  const env = getEnv();
  if (!env.COMPOSIO_API_KEY) throw new EmaError("CONFIG", "COMPOSIO_API_KEY absente : le POC Composio ne peut pas fonctionner");
  return new ComposioClient({ apiKey: env.COMPOSIO_API_KEY, baseUrl: env.COMPOSIO_BASE_URL, fetchImpl });
}
