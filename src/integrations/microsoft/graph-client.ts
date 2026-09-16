import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { loadTokenSet, saveTokenSet } from "./token-store";
import { refreshTokenSet } from "./oauth";
import type { GraphErrorBody, GraphPage } from "./types";

const log = createLogger("microsoft.graph");

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 60_000;

export interface GraphClientOptions {
  /** Fournit un access token valide (rafraîchi si nécessaire). */
  getAccessToken: () => Promise<string>;
  /** Appelé sur 401 : force un rafraîchissement et renvoie le nouveau token (null = abandon). */
  onUnauthorized?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseUrl?: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * `true` : la requête peut être rejouée sans effet de bord (GET, HEAD).
   * `false` : un envoi d'email — une réponse perdue signifie que Microsoft a
   * peut-être déjà envoyé le message. Défaut : déduit de la méthode.
   */
  idempotent?: boolean;
}

/**
 * Envoi transmis à Microsoft sans réponse exploitable (coupure réseau, 5xx,
 * délai dépassé). Le message a PEUT-ÊTRE été envoyé : ne jamais rejouer
 * automatiquement, ne jamais conclure « non envoyé ».
 */
export class DeliveryAmbiguousError extends EmaError {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null, cause?: unknown) {
    super("DELIVERY_AMBIGUOUS", message, { details: { httpStatus }, cause });
    this.name = "DeliveryAmbiguousError";
    this.httpStatus = httpStatus;
  }
}

export function isDeliveryAmbiguous(err: unknown): err is DeliveryAmbiguousError {
  return err instanceof EmaError && err.code === "DELIVERY_AMBIGUOUS";
}

const AMBIGUOUS_HINT = "Résultat inconnu : Microsoft a peut-être déjà envoyé le message. Vérification humaine requise avant toute nouvelle tentative.";

export class GraphError extends EmaError {
  readonly httpStatus: number;
  readonly graphCode: string | null;
  constructor(httpStatus: number, graphCode: string | null, message: string) {
    super("INTEGRATION", message, { status: httpStatus === 404 ? 404 : 502, details: { httpStatus, graphCode } });
    this.name = "GraphError";
    this.httpStatus = httpStatus;
    this.graphCode = graphCode;
  }
}

/**
 * Client Microsoft Graph centralisé : token, refresh, 401, 429 (Retry-After),
 * 5xx (backoff), erreurs Graph assainies, pagination.
 */
export class GraphClient {
  private readonly opts: Required<Pick<GraphClientOptions, "getAccessToken" | "fetchImpl" | "sleep" | "maxRetries" | "baseUrl">> & Pick<GraphClientOptions, "onUnauthorized">;

  constructor(options: GraphClientOptions) {
    this.opts = {
      getAccessToken: options.getAccessToken,
      onUnauthorized: options.onUnauthorized,
      fetchImpl: options.fetchImpl ?? fetch,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      maxRetries: options.maxRetries ?? 3,
      baseUrl: options.baseUrl ?? GRAPH_BASE_URL,
    };
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    if (/^https?:\/\//i.test(path)) return path; // nextLink / deltaLink absolus
    const u = new URL(`${this.opts.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    // Options OData lisibles ($select, $filter…) plutôt que %24select.
    return u.toString().replace(/%24/g, "$");
  }

  /**
   * Requête brute avec gestion des erreurs et des retries.
   * Les requêtes NON idempotentes (envoi d'email) ne sont jamais rejouées quand
   * le résultat est ambigu : réseau coupé, 5xx, délai dépassé. Seuls un 401
   * (requête rejetée avant traitement, rejouée après rafraîchissement du token)
   * et un 429 (rejetée par la limitation de débit) sont sûrs à rejouer.
   */
  async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    let token = await this.opts.getAccessToken();
    let unauthorizedRetried = false;
    let attempt = 0;
    const url = this.url(path, options.query);
    const idempotent = options.idempotent ?? isIdempotentMethod(method);
    for (;;) {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", ...options.headers };
      const init: RequestInit = { method, headers };
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      let res: Response;
      try {
        res = await this.opts.fetchImpl(url, init);
      } catch (err) {
        // La requête est partie : impossible de savoir si Microsoft l'a traitée.
        if (!idempotent) throw new DeliveryAmbiguousError(`Microsoft Graph injoignable pendant l'envoi. ${AMBIGUOUS_HINT}`, null, err);
        if (attempt < this.opts.maxRetries) {
          attempt++;
          await this.opts.sleep(backoff(attempt));
          continue;
        }
        throw new EmaError("INTEGRATION", "Microsoft Graph injoignable", { cause: err });
      }
      if (res.ok) return res;

      if (res.status === 401 && !unauthorizedRetried && this.opts.onUnauthorized) {
        unauthorizedRetried = true;
        const fresh = await this.opts.onUnauthorized();
        if (fresh) {
          token = fresh;
          continue;
        }
      }
      // 429 : la requête a été refusée avant traitement, un nouvel essai est sûr.
      const throttled = res.status === 429;
      const transient = throttled || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504;
      if (transient && (idempotent || throttled) && attempt < this.opts.maxRetries) {
        attempt++;
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = throttled && Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : backoff(attempt);
        log.warn("graph transient error, retrying", { status: res.status, attempt, waitMs: wait, idempotent });
        await this.opts.sleep(wait);
        continue;
      }
      if (transient && !idempotent) {
        // 5xx sur un envoi : Microsoft a pu accepter puis échouer à répondre.
        const err = await toGraphError(res);
        log.warn("graph send result ambiguous", { status: res.status });
        throw new DeliveryAmbiguousError(`${err.message}. ${AMBIGUOUS_HINT}`, res.status, err);
      }
      throw await toGraphError(res);
    }
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, options);
    if (res.status === 202 || res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  get<T>(path: string, query?: RequestOptions["query"], headers?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, { query, headers });
  }

  /** POST : non idempotent par défaut (aucun rejeu automatique en cas d'ambiguïté). */
  post<T>(path: string, body: unknown, headers?: Record<string, string>, idempotent = false): Promise<T> {
    return this.request<T>("POST", path, { body, headers, idempotent });
  }

  async getBinary(path: string): Promise<Buffer> {
    const res = await this.raw("GET", path, { headers: { accept: "*/*" } });
    return Buffer.from(await res.arrayBuffer());
  }

  /** Suit @odata.nextLink jusqu'à `limit` éléments. */
  async getAll<T>(path: string, query?: RequestOptions["query"], opts: { limit?: number; headers?: Record<string, string> } = {}): Promise<T[]> {
    const limit = opts.limit ?? 200;
    const out: T[] = [];
    let next: string | null = this.url(path, query);
    while (next && out.length < limit) {
      const page: GraphPage<T> = await this.get<GraphPage<T>>(next, undefined, opts.headers);
      out.push(...page.value);
      next = page["@odata.nextLink"] ?? null;
    }
    return out.slice(0, limit);
  }
}

function isIdempotentMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 10_000);
}

async function toGraphError(res: Response): Promise<GraphError> {
  let code: string | null = null;
  let message = `Microsoft Graph a répondu ${res.status}`;
  try {
    const body = (await res.json()) as GraphErrorBody;
    code = body.error?.code ?? null;
    if (body.error?.message) message = `${message} (${code ?? "erreur"}) : ${body.error.message.slice(0, 200)}`;
  } catch {
    /* corps non JSON */
  }
  return new GraphError(res.status, code, message);
}

/* Fabrique connectée au stockage de tokens ---------------------------------- */

export interface ConnectedClientDeps {
  db?: Db;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Client relié à oauth_tokens : rafraîchit le token avant expiration (marge de
 * 2 minutes) et sur 401. Lève NOT_FOUND/CONFIG si Outlook n'est pas connecté.
 */
export function createConnectedGraphClient(deps: ConnectedClientDeps = {}): GraphClient {
  const db = deps.db ?? getDb();
  const now = deps.now ?? Date.now;
  let refreshing: Promise<string> | null = null;

  const refresh = async (): Promise<string> => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const stored = loadTokenSet(db);
      if (!stored) throw new EmaError("CONFIG", "Outlook n'est pas connecté");
      const fresh = await refreshTokenSet(stored.set.refreshToken, { db, fetchImpl: deps.fetchImpl, now });
      saveTokenSet(fresh, stored.accountEmail, db);
      log.info("token refreshed", { expiresAt: fresh.expiresAt });
      return fresh.accessToken;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  return new GraphClient({
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    getAccessToken: async () => {
      const stored = loadTokenSet(db);
      if (!stored) throw new EmaError("CONFIG", "Outlook n'est pas connecté");
      if (new Date(stored.set.expiresAt).getTime() - now() < REFRESH_MARGIN_MS) return refresh();
      return stored.set.accessToken;
    },
    onUnauthorized: async () => {
      try {
        return await refresh();
      } catch (err) {
        log.warn("refresh after 401 failed", { message: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
  });
}

export function isOutlookConnected(db: Db = getDb()): boolean {
  return loadTokenSet(db) !== null;
}
