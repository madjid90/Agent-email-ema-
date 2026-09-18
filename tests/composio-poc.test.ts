import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openIsolatedDb, type Db } from "@/database/connection";
import * as users from "@/database/repositories/users";
import { getComposioConnection, updateComposioConnection } from "@/database/repositories/composio-connections";
import { listHistory } from "@/database/repositories/history";
import { ComposioClient, ComposioError, createComposioClient, DEFAULT_COMPOSIO_BASE_URL, parseInputParameters, sanitizeAccount } from "@/integrations/composio/client";
import { assertReadOnlySlug, isReadOnlyTool, managedOAuthScopes, OPERATION_TOOLS, POC_READ_ONLY_SCOPES, resolveOperation } from "@/integrations/composio/policy";
import { completeComposioCallback, disconnectComposio, findEmail, getPocState, listPocTools, LOCAL_CALLBACK_WARNING, refreshComposioConnection, resetComposioPocForTests, resolveCallbackMode, runPocRead, shapeArguments, startComposioConnection } from "@/integrations/composio/outlook-poc";
import { resetEnvCache } from "@/lib/env";
import { fakeFetch, json, type RecordedCall } from "./helpers/fake-graph";

/** Utilisateur de session simulé pour les tests de route (le wrapper `route()` lit getSessionUser). */
const sessionUserRef: { current: import("@/database/types").UserRow | null } = { current: null };
vi.mock("@/security/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/security/auth")>();
  return {
    ...original,
    getSessionUser: async () => sessionUserRef.current,
    requireSessionUser: async () => {
      if (!sessionUserRef.current) throw new (await import("@/lib/errors")).EmaError("UNAUTHORIZED", "Authentification requise");
      return sessionUserRef.current;
    },
  };
});

/** Clé factice, jamais réelle : sert uniquement à prouver qu'elle ne fuit nulle part. */
const FAKE_KEY = "composio-test-key-DO-NOT-LEAK-0123456789";
const FAKE_TOKEN = "microsoft-access-token-FROM-COMPOSIO-never-stored";

const setEnv = (key: string, value: string | undefined): void => {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
};

interface FakeAccount {
  id: string;
  status: string;
  user_id: string;
  status_reason?: string | null;
  requested_scopes?: string[];
}

/** Description d'un tool au format v3.1 : `params` = { nom: requis }. */
interface FakeTool {
  slug: string;
  params?: Record<string, boolean>;
}

/** Catalogue Outlook Composio actuel (extrait) : tools de lecture retenus, autres tools de lecture, tools d'écriture. */
const CURRENT_OUTLOOK_CATALOGUE: FakeTool[] = [
  { slug: "OUTLOOK_LIST_MESSAGES", params: { top: false, folder: false, user_id: false } },
  { slug: "OUTLOOK_SEARCH_MESSAGES", params: { search: true, top: false } },
  { slug: "OUTLOOK_QUERY_EMAILS", params: { query: true, max_results: false } },
  { slug: "OUTLOOK_GET_MESSAGE", params: { message_id: true, user_id: false } },
  { slug: "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS", params: { message_id: true } },
  { slug: "OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT", params: { message_id: true, attachment_id: true } },
  { slug: "OUTLOOK_LIST_EVENTS", params: { start_datetime: false, end_datetime: false, top: false } },
  { slug: "OUTLOOK_GET_PROFILE", params: {} },
  { slug: "OUTLOOK_GET_EVENT_ATTACHMENT", params: { event_id: true, attachment_id: true } },
  { slug: "OUTLOOK_LIST_MAIL_FOLDERS", params: {} },
  { slug: "OUTLOOK_GET_EVENT", params: { event_id: true } },
  { slug: "OUTLOOK_SEND_EMAIL", params: { to_email: true, subject: true, body: true } },
  { slug: "OUTLOOK_REPLY_EMAIL", params: { message_id: true, body: true } },
  { slug: "OUTLOOK_FORWARD_EMAIL", params: { message_id: true, to: true } },
  { slug: "OUTLOOK_DELETE_MESSAGE", params: { message_id: true } },
  { slug: "OUTLOOK_MOVE_MESSAGE", params: { message_id: true, destination_id: true } },
  { slug: "OUTLOOK_MARK_AS_READ", params: { message_id: true } },
  { slug: "OUTLOOK_CREATE_EVENT", params: { subject: true } },
  { slug: "OUTLOOK_UPDATE_EVENT", params: { event_id: true } },
  { slug: "OUTLOOK_DELETE_EVENT", params: { event_id: true } },
  { slug: "OUTLOOK_CREATE_DRAFT", params: { subject: true } },
  { slug: "OUTLOOK_ADD_ATTACHMENT_TO_EVENT", params: { event_id: true } },
  { slug: "OUTLOOK_BATCH_MOVE_MESSAGES", params: { message_ids: true } },
  { slug: "OUTLOOK_BATCH_UPDATE_MESSAGES", params: { message_ids: true } },
];

/** Forme v3.1 documentée : mapping direct `{ nom: { type, description, required, example } }`. */
function v31InputParameters(params: Record<string, boolean> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([name, required]) => [name, { type: "string", description: `Paramètre ${name}`, required, example: "…" }]));
}

/** Faux serveur Composio v3.1 : catalogue Outlook, comptes connectés par utilisateur, complete_auth. */
function fakeComposio(opts: { accounts?: FakeAccount[]; tools?: FakeTool[]; executeFails?: string | null; profileEmail?: string | null; sessions?: Map<string, { accountId: string; ownerUserId: string }> } = {}) {
  const accounts = new Map((opts.accounts ?? []).map((a) => [a.id, a]));
  const tools = opts.tools ?? CURRENT_OUTLOOK_CATALOGUE;
  const sessions = opts.sessions ?? new Map<string, { accountId: string; ownerUserId: string }>();
  const executed: { slug: string; body: Record<string, unknown> }[] = [];
  let linkCount = 0;
  const { fetchImpl, calls } = fakeFetch([
    {
      match: /POST .*\/api\/v3\.1\/connected_accounts\/complete_auth$/,
      handle: (call) => {
        const body = call.body as Record<string, string>;
        const session = sessions.get(body.session_uri ?? "");
        if (!session) return json({ error: { message: "Session not found or expired", code: "not_found" } }, 404);
        sessions.delete(body.session_uri ?? ""); // usage unique, quel que soit le résultat
        const account = accounts.get(session.accountId);
        if (!account) return json({ error: { message: "Connection not found" } }, 404);
        if (session.ownerUserId !== body.user_id) {
          Object.assign(account, { status: "FAILED", status_reason: "Callback identity verification failed" });
          return json({ error: { message: "Callback identity verification failed", code: "bad_request" } }, 400);
        }
        account.status = "ACTIVE";
        return json({ connected_account_id: account.id, toolkit_slug: "outlook", status: "ACTIVE" });
      },
    },
    { match: /GET .*\/api\/v3\.1\/auth_configs\?/, handle: () => json({ items: [{ id: "ac_outlook_ro", name: "Outlook lecture seule", toolkit: { slug: "outlook" }, is_composio_managed: false }] }) },
    {
      match: /POST .*\/api\/v3\.1\/connected_accounts\/link$/,
      handle: (call) => {
        const body = call.body as Record<string, string>;
        linkCount++;
        const id = `ca_${body.user_id}_${linkCount}`;
        accounts.set(id, { id, status: "INITIATED", user_id: body.user_id ?? "" });
        return json({ connected_account_id: id, redirect_url: `https://backend.composio.dev/link/${id}`, link_token: "lt_x", expires_at: new Date(Date.now() + 600_000).toISOString() });
      },
    },
    {
      match: /GET .*\/api\/v3\.1\/connected_accounts\/[^/?]+$/,
      handle: (call) => {
        const id = decodeURIComponent(call.url.split("/").pop() as string);
        const a = accounts.get(id);
        if (!a) return json({ error: { message: "Connected account not found", code: "not_found" } }, 404);
        // Composio renvoie l'état complet, access token compris : le client doit l'ignorer.
        return json({ id: a.id, status: a.status, status_reason: a.status_reason ?? null, user_id: a.user_id, toolkit: { slug: "outlook" }, auth_config: { id: "ac_outlook_ro" }, requested_scopes: a.requested_scopes ?? ["Mail.Read", "Calendars.Read", "User.Read", "offline_access"], is_disabled: false, created_at: "2026-09-18T10:00:00Z", updated_at: "2026-09-18T10:00:00Z", state: { authScheme: "OAUTH2", val: { status: a.status, access_token: FAKE_TOKEN, refresh_token: "rt-secret" } }, data: { access_token: FAKE_TOKEN } });
      },
    },
    { match: /DELETE .*\/api\/v3\.1\/connected_accounts\/[^/?]+\?revoke_on_delete=true$/, handle: (call) => { const id = decodeURIComponent((call.url.split("/").pop() ?? "").split("?")[0] ?? ""); if (!accounts.has(id)) return json({ error: { message: "not found" } }, 404); accounts.delete(id); return json({ success: true }); } },
    { match: /GET .*\/api\/v3\.1\/tools\?/, handle: () => json({ items: tools.map((t) => ({ slug: t.slug, name: t.slug.toLowerCase(), description: `Tool ${t.slug}`, toolkit: { slug: "outlook", name: "Outlook" }, scopes: [], tags: [], is_deprecated: false, version: "0_1", available_versions: ["0_1"], no_auth: false, input_parameters: v31InputParameters(t.params), output_parameters: { data: { type: "object" } } })), current_page: 1, total_items: tools.length, total_pages: 1, next_cursor: null }) },
    {
      match: /POST .*\/api\/v3\.1\/tools\/execute\/[^/]+$/,
      handle: (call) => {
        const slug = decodeURIComponent(call.url.split("/").pop() as string);
        const body = call.body as Record<string, unknown>;
        executed.push({ slug, body });
        const account = accounts.get(String(body.connected_account_id));
        if (!account || account.user_id !== body.user_id) return json({ successful: false, data: {}, error: "Connected account does not belong to user" });
        if (opts.executeFails) return json({ successful: false, data: {}, error: opts.executeFails });
        if (slug.endsWith("GET_PROFILE")) return json({ successful: true, data: opts.profileEmail === null ? {} : { mail: opts.profileEmail ?? `${account.user_id}@3t.example`, displayName: "Compte 3T" }, error: null, log_id: "log_1" });
        if (slug.endsWith("DOWNLOAD_OUTLOOK_ATTACHMENT")) return json({ successful: true, data: { name: "devis.pdf", size: 12, contentBytes: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, error: null });
        return json({ successful: true, data: { owner: account.user_id, messages: [{ id: `m-${account.user_id}`, subject: `Boîte de ${account.user_id}` }] }, error: null, log_id: "log_2" });
      },
    },
  ]);
  return { fetchImpl, calls, accounts, executed, sessions };
}

function client(fetchImpl: typeof fetch): ComposioClient {
  return new ComposioClient({ apiKey: FAKE_KEY, baseUrl: "https://backend.composio.dev", fetchImpl });
}

describe("POC Composio — activation et configuration", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    resetComposioPocForTests();
  });
  afterEach(() => {
    setEnv("COMPOSIO_POC_ENABLED", undefined);
    setEnv("COMPOSIO_API_KEY", undefined);
    resetEnvCache();
  });

  it("désactivé (défaut) : aucune opération possible, EMA inchangé", async () => {
    resetEnvCache();
    const u = users.createUser({ email: "a@3t.fr" }, db);
    expect(getPocState(u, db)).toMatchObject({ enabled: false, configured: false, status: "disconnected", configError: "COMPOSIO_POC_ENABLED=false" });
    await expect(startComposioConnection(u, "https://ema/cb", { db })).rejects.toMatchObject({ code: "CONFIG" });
    await expect(runPocRead(u, "list_recent", {}, { db })).rejects.toMatchObject({ code: "CONFIG" });
    const { requirePoc } = await import("@/app/api/poc/composio/_guard");
    expect(() => requirePoc()).toThrow(/désactivé/);
  });

  it("activé sans clé : refus clair, jamais d'appel réseau", async () => {
    setEnv("COMPOSIO_POC_ENABLED", "true");
    setEnv("COMPOSIO_API_KEY", undefined);
    resetEnvCache();
    const u = users.createUser({ email: "a@3t.fr" }, db);
    expect(getPocState(u, db)).toMatchObject({ enabled: true, configured: false, configError: "COMPOSIO_API_KEY absente dans .env" });
    expect(() => createComposioClient()).toThrow(/COMPOSIO_API_KEY absente/);
    const { calls, fetchImpl } = fakeComposio();
    await expect(startComposioConnection(u, "https://ema/cb", { db, fetchImpl })).rejects.toMatchObject({ code: "CONFIG" });
    expect(calls).toHaveLength(0);
  });
});

describe("POC Composio — connexion par utilisateur, isolation, statuts", () => {
  let db: Db;
  let a: ReturnType<typeof users.createUser>;
  let b: ReturnType<typeof users.createUser>;

  beforeEach(() => {
    db = openIsolatedDb();
    resetComposioPocForTests();
    setEnv("COMPOSIO_POC_ENABLED", "true");
    setEnv("COMPOSIO_API_KEY", FAKE_KEY);
    setEnv("COMPOSIO_OUTLOOK_AUTH_CONFIG_ID", undefined);
    resetEnvCache();
    a = users.createUser({ email: "a@3t.fr", name: "A" }, db);
    b = users.createUser({ email: "b@3t.fr", name: "B" }, db);
  });
  afterEach(() => {
    setEnv("COMPOSIO_POC_ENABLED", undefined);
    setEnv("COMPOSIO_API_KEY", undefined);
    resetEnvCache();
  });

  it("connexion : lien créé avec user_id = identifiant EMA, auth config découverte, référence stockée sans token", async () => {
    const fake = fakeComposio();
    const r = await startComposioConnection(a, "https://ema.test/api/poc/composio/callback", { db, client: client(fake.fetchImpl) });
    expect(r.redirectUrl).toMatch(/^https:\/\/backend\.composio\.dev\/link\//);
    const link = fake.calls.find((c) => c.url.endsWith("/connected_accounts/link"))!;
    expect(link.body).toEqual({ auth_config_id: "ac_outlook_ro", user_id: a.id, callback_url: "https://ema.test/api/poc/composio/callback" });
    expect(link.headers["x-api-key"]).toBe(FAKE_KEY);
    const row = getComposioConnection(a.id, db)!;
    expect(row).toMatchObject({ user_id: a.id, connected_account_id: r.connectedAccountId, auth_config_id: "ac_outlook_ro", status: "INITIATED" });
    expect(JSON.stringify(row)).not.toContain(FAKE_TOKEN);
    expect(getPocState(a, db).status).toBe("connecting");
    expect(getComposioConnection(b.id, db)).toBeUndefined();
  });

  it("statut : INITIATED → connecting, ACTIVE → connected + adresse via le tool de profil, sans jamais conserver le token", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    expect((await refreshComposioConnection(a, { db, client: c })).status).toBe("connecting");
    fake.accounts.get(connectedAccountId)!.status = "ACTIVE";
    const state = await refreshComposioConnection(a, { db, client: c });
    expect(state.status).toBe("connected");
    expect(state.accountEmail).toBe(`${a.id}@3t.example`);
    expect(state.requestedScopes).toEqual(["Mail.Read", "Calendars.Read", "User.Read", "offline_access"]);
    expect(state.writeScopesDetected).toEqual([]);
    const row = getComposioConnection(a.id, db)!;
    expect(JSON.stringify(row)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(state)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(state)).not.toContain(FAKE_KEY);
  });

  it("scopes d'écriture demandés par l'auth config : signalés à l'écran", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    Object.assign(fake.accounts.get(connectedAccountId)!, { status: "ACTIVE", requested_scopes: ["Mail.ReadWrite", "Mail.Send", "Calendars.Read"] });
    const state = await refreshComposioConnection(a, { db, client: c });
    expect(state.writeScopesDetected).toEqual(["Mail.ReadWrite", "Mail.Send"]);
  });

  it("isolation : B n'a aucune connexion → refus ; chaque exécution porte le compte ET l'utilisateur propriétaire", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    fake.accounts.get(connectedAccountId)!.status = "ACTIVE";
    await refreshComposioConnection(a, { db, client: c });

    const ra = await runPocRead(a, "list_recent", { limit: 5 }, { db, client: c });
    expect(ra.ok).toBe(true);
    expect(JSON.stringify(ra.data)).toContain(`Boîte de ${a.id}`);
    const exec = fake.executed.find((e) => e.slug === "OUTLOOK_LIST_MESSAGES")!;
    expect(exec.body).toMatchObject({ connected_account_id: connectedAccountId, user_id: a.id, arguments: { top: 5 } });

    await expect(runPocRead(b, "list_recent", {}, { db, client: c })).rejects.toMatchObject({ code: "MICROSOFT_RECONNECT" });
    expect(fake.executed.filter((e) => e.body.user_id === b.id)).toHaveLength(0);
    expect(getPocState(b, db).status).toBe("disconnected");
  });

  it("isolation : une référence pointant vers le compte d'un autre utilisateur est rejetée et supprimée", async () => {
    const fake = fakeComposio({ accounts: [{ id: "ca_of_b", status: "ACTIVE", user_id: b.id }] });
    const c = client(fake.fetchImpl);
    // Ligne corrompue : A référence le compte de B.
    db.prepare("INSERT INTO composio_connections (user_id, connected_account_id, auth_config_id, status, created_at, updated_at) VALUES (?, 'ca_of_b', 'ac', 'ACTIVE', 'x', 'x')").run(a.id);
    await expect(refreshComposioConnection(a, { db, client: c })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getComposioConnection(a.id, db)).toBeUndefined();
    await expect(runPocRead(a, "list_recent", {}, { db, client: c })).rejects.toMatchObject({ code: "MICROSOFT_RECONNECT" });
  });

  it("deux utilisateurs connectés en parallèle : chacun lit SA boîte", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const la = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    const lb = await startComposioConnection(b, "https://ema.test/cb", { db, client: c });
    fake.accounts.get(la.connectedAccountId)!.status = "ACTIVE";
    fake.accounts.get(lb.connectedAccountId)!.status = "ACTIVE";
    await Promise.all([refreshComposioConnection(a, { db, client: c }), refreshComposioConnection(b, { db, client: c })]);
    const [ra, rb] = await Promise.all([runPocRead(a, "search", { query: "devis", limit: 3 }, { db, client: c }), runPocRead(b, "search", { query: "devis", limit: 3 }, { db, client: c })]);
    expect(JSON.stringify(ra.data)).toContain(`Boîte de ${a.id}`);
    expect(JSON.stringify(ra.data)).not.toContain(`Boîte de ${b.id}`);
    expect(JSON.stringify(rb.data)).toContain(`Boîte de ${b.id}`);
    expect(fake.executed.every((e) => e.body.connected_account_id === (e.body.user_id === a.id ? la.connectedAccountId : lb.connectedAccountId))).toBe(true);
  });

  it("connexion inexistante chez Composio (404) → reconnexion requise", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    fake.accounts.delete(connectedAccountId);
    const state = await refreshComposioConnection(a, { db, client: c });
    expect(state.status).toBe("reconnect_required");
    expect(state.statusReason).toMatch(/introuvable/);
  });

  it("connexion révoquée : statut REVOKED → reconnexion requise ; erreur d'auth à l'exécution → EXPIRED", async () => {
    const fake = fakeComposio({ executeFails: "401 Unauthorized: token expired" });
    const c = client(fake.fetchImpl);
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    Object.assign(fake.accounts.get(connectedAccountId)!, { status: "REVOKED", status_reason: "Revoked via user-initiated revoke endpoint" });
    expect((await refreshComposioConnection(a, { db, client: c })).status).toBe("reconnect_required");
    await expect(runPocRead(a, "list_recent", {}, { db, client: c })).rejects.toMatchObject({ code: "MICROSOFT_RECONNECT" });

    fake.accounts.get(connectedAccountId)!.status = "ACTIVE";
    updateComposioConnection(a.id, { accountEmail: "deja@3t.fr" }, db); // évite l'appel de profil au rafraîchissement
    await refreshComposioConnection(a, { db, client: c });
    expect(getPocState(a, db).status).toBe("connected");
    const r = await runPocRead(a, "list_recent", {}, { db, client: c });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/token expired/);
    expect(getPocState(a, db).status).toBe("reconnect_required");
  });

  it("approbation administrateur Microsoft : détectée et signalée, jamais contournée", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    Object.assign(fake.accounts.get(connectedAccountId)!, { status: "FAILED", status_reason: "OAuth callback failed during token exchange: AADSTS65001 admin consent required" });
    const state = await refreshComposioConnection(a, { db, client: c });
    expect(state.status).toBe("error");
    expect(state.adminApprovalRequired).toBe(true);
  });

  it("erreur API Composio (500, injoignable, 401) : message exploitable, état conservé, aucune fuite de clé", async () => {
    const { fetchImpl: failing } = fakeFetch([{ match: /.*/, handle: () => json({ error: { message: "internal error", code: "internal" } }, 500) }]);
    await expect(client(failing).listTools("outlook")).rejects.toMatchObject({ code: "INTEGRATION" });
    await expect(client(failing).listTools("outlook")).rejects.toThrow(/Composio a répondu 500/);

    const { fetchImpl: down } = fakeFetch([{ match: /.*/, handle: () => { throw new TypeError("fetch failed"); } }]);
    await expect(client(down).getAccount("ca_x")).rejects.toThrow(/injoignable/);

    const { fetchImpl: unauthorized } = fakeFetch([{ match: /.*/, handle: () => json({ error: { message: "Invalid API key" } }, 401) }]);
    let message = "";
    try {
      await client(unauthorized).listTools("outlook");
    } catch (err) {
      message = err instanceof ComposioError ? err.message : String(err);
    }
    expect(message).toMatch(/refusé la clé API/);
    expect(message).not.toContain(FAKE_KEY);

    // Erreur pendant un rafraîchissement : la référence reste, l'erreur est mémorisée sans secret.
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    const state = await refreshComposioConnection(a, { db, client: client(failing) });
    expect(state.status).toBe("connecting");
    expect(state.lastError).toMatch(/500/);
    expect(JSON.stringify(state)).not.toContain(FAKE_KEY);
  });

  it("aucune fuite de clé ni de token : journaux, historique, état, erreurs", async () => {
    const lines: string[] = [];
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
    try {
      const fake = fakeComposio();
      const c = client(fake.fetchImpl);
      const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
      fake.accounts.get(connectedAccountId)!.status = "ACTIVE";
      await refreshComposioConnection(a, { db, client: c });
      await runPocRead(a, "list_recent", { limit: 2 }, { db, client: c });
      await runPocRead(a, "get_attachment", { message_id: "m1", attachment_id: "att1" }, { db, client: c });
      await disconnectComposio(a, { db, client: c });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const everything = [...lines, JSON.stringify(listHistory({ limit: 50 }, db)), JSON.stringify(getPocState(a, db))].join("\n");
    expect(everything).not.toContain(FAKE_KEY);
    expect(everything).not.toContain(FAKE_TOKEN);
    expect(everything).not.toContain("rt-secret");
  });

  it("déconnexion : suppression + révocation côté Composio, référence oubliée ; reconnexion : nouveau compte", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const first = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    const state = await disconnectComposio(a, { db, client: c });
    expect(state.status).toBe("disconnected");
    expect(fake.calls.some((x) => x.method === "DELETE" && x.url.includes(first.connectedAccountId) && x.url.includes("revoke_on_delete=true"))).toBe(true);
    expect(getComposioConnection(a.id, db)).toBeUndefined();
    expect(listHistory({ limit: 10, userId: a.id }, db).some((h) => h.event_type === "composio.disconnected")).toBe(true);
    const second = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    expect(second.connectedAccountId).not.toBe(first.connectedAccountId);
    expect(getComposioConnection(a.id, db)?.connected_account_id).toBe(second.connectedAccountId);
  });
});

describe("POC Composio — politique lecture seule (fail-closed)", () => {
  let db: Db;
  let a: ReturnType<typeof users.createUser>;
  beforeEach(() => {
    db = openIsolatedDb();
    resetComposioPocForTests();
    setEnv("COMPOSIO_POC_ENABLED", "true");
    setEnv("COMPOSIO_API_KEY", FAKE_KEY);
    resetEnvCache();
    a = users.createUser({ email: "a@3t.fr" }, db);
  });
  afterEach(() => {
    setEnv("COMPOSIO_POC_ENABLED", undefined);
    setEnv("COMPOSIO_API_KEY", undefined);
    resetEnvCache();
  });

  it("classe les tools du catalogue actuel : exécutables (table), lecture non retenue, écriture/destructif refusé", async () => {
    const fake = fakeComposio();
    const { allowed, readOnlyUnused, blocked } = await listPocTools({ db, client: client(fake.fetchImpl) });
    const allowedSlugs = allowed.map((t) => t.slug);
    const blockedSlugs = blocked.map((t) => t.slug);
    expect(allowedSlugs.sort()).toEqual(["OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT", "OUTLOOK_GET_MESSAGE", "OUTLOOK_GET_PROFILE", "OUTLOOK_LIST_EVENTS", "OUTLOOK_LIST_MESSAGES", "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS", "OUTLOOK_QUERY_EMAILS", "OUTLOOK_SEARCH_MESSAGES"]);
    // Lecture mais hors table : jamais exécutables (dont la pièce jointe d'événement).
    expect(readOnlyUnused.map((t) => t.slug).sort()).toEqual(["OUTLOOK_GET_EVENT", "OUTLOOK_GET_EVENT_ATTACHMENT", "OUTLOOK_LIST_MAIL_FOLDERS"]);
    for (const s of ["OUTLOOK_SEND_EMAIL", "OUTLOOK_REPLY_EMAIL", "OUTLOOK_FORWARD_EMAIL", "OUTLOOK_DELETE_MESSAGE", "OUTLOOK_MOVE_MESSAGE", "OUTLOOK_MARK_AS_READ", "OUTLOOK_CREATE_EVENT", "OUTLOOK_UPDATE_EVENT", "OUTLOOK_DELETE_EVENT", "OUTLOOK_CREATE_DRAFT", "OUTLOOK_ADD_ATTACHMENT_TO_EVENT", "OUTLOOK_BATCH_MOVE_MESSAGES", "OUTLOOK_BATCH_UPDATE_MESSAGES"]) {
      expect(blockedSlugs).toContain(s);
      expect(allowedSlugs).not.toContain(s);
    }
    // Un tool d'un autre toolkit, même « GET », est refusé ; un tool déprécié aussi.
    expect(isReadOnlyTool({ slug: "GMAIL_GET_MESSAGE", toolkit: "gmail", deprecated: false })).toBe(false);
    expect(isReadOnlyTool({ slug: "OUTLOOK_GET_MESSAGE", toolkit: "outlook", deprecated: true })).toBe(false);
    // Un slug ambigu qui mélange lecture et écriture est refusé.
    expect(isReadOnlyTool({ slug: "OUTLOOK_GET_AND_DELETE_MESSAGE", toolkit: "outlook", deprecated: false })).toBe(false);
  });

  it("assertReadOnlySlug : slug inconnu ou d'écriture → FORBIDDEN, jamais exécuté", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const tools = await c.listTools("outlook");
    expect(() => assertReadOnlySlug("OUTLOOK_SEND_EMAIL", tools)).toThrow(/refusé par la politique/);
    expect(() => assertReadOnlySlug("OUTLOOK_DELETE_MESSAGE", tools)).toThrow(/refusé par la politique/);
    expect(() => assertReadOnlySlug("OUTLOOK_SOMETHING_NEW", tools)).toThrow(/inconnu/);
    // Lecture mais hors table déterministe : refusé.
    expect(() => assertReadOnlySlug("OUTLOOK_GET_EVENT_ATTACHMENT", tools)).toThrow(/hors de la table/);
    expect(() => assertReadOnlySlug("OUTLOOK_LIST_MAIL_FOLDERS", tools)).toThrow(/hors de la table/);
    // Dans la table, mais pas pour cette opération : refusé.
    expect(() => assertReadOnlySlug("OUTLOOK_LIST_EVENTS", tools, "get_attachment")).toThrow(/non autorisé pour l'opération/);
    expect(() => assertReadOnlySlug("OUTLOOK_GET_MESSAGE", tools, "get_message")).not.toThrow();
  });

  it("résolution déterministe : slugs actuels, fallback documenté pour la recherche, jamais un autre objet métier", async () => {
    const full = await client(fakeComposio().fetchImpl).listTools("outlook");
    expect(resolveOperation("list_recent", full).slug).toBe("OUTLOOK_LIST_MESSAGES");
    expect(resolveOperation("search", full).slug).toBe("OUTLOOK_SEARCH_MESSAGES");
    expect(resolveOperation("get_message", full).slug).toBe("OUTLOOK_GET_MESSAGE");
    expect(resolveOperation("list_attachments", full).slug).toBe("OUTLOOK_LIST_OUTLOOK_ATTACHMENTS");
    expect(resolveOperation("get_attachment", full).slug).toBe("OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT");
    expect(resolveOperation("list_events", full).slug).toBe("OUTLOOK_LIST_EVENTS");
    expect(resolveOperation("get_profile", full).slug).toBe("OUTLOOK_GET_PROFILE");

    // Recherche : OUTLOOK_QUERY_EMAILS en repli documenté si OUTLOOK_SEARCH_MESSAGES est absent.
    const noSearch = await client(fakeComposio({ tools: CURRENT_OUTLOOK_CATALOGUE.filter((t) => t.slug !== "OUTLOOK_SEARCH_MESSAGES") }).fetchImpl).listTools("outlook");
    expect(resolveOperation("search", noSearch).slug).toBe("OUTLOOK_QUERY_EMAILS");

    // Pièce jointe : sans OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT, JAMAIS OUTLOOK_GET_EVENT_ATTACHMENT (calendrier).
    const noDownload = await client(fakeComposio({ tools: CURRENT_OUTLOOK_CATALOGUE.filter((t) => t.slug !== "OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT") }).fetchImpl).listTools("outlook");
    expect(() => resolveOperation("get_attachment", noDownload)).toThrow(/Aucun tool autorisé .* get_attachment/);
    expect(() => resolveOperation("get_attachment", noDownload)).toThrow(/OUTLOOK_GET_EVENT_ATTACHMENT/); // listé comme présent, jamais choisi
    // Calendrier : sans OUTLOOK_LIST_EVENTS, aucun tool de messages n'est pris.
    const noEvents = await client(fakeComposio({ tools: CURRENT_OUTLOOK_CATALOGUE.filter((t) => t.slug !== "OUTLOOK_LIST_EVENTS") }).fetchImpl).listTools("outlook");
    expect(() => resolveOperation("list_events", noEvents)).toThrow(/Aucun tool autorisé/);

    // Catalogue sans aucun tool de lecture attendu : échec explicite, jamais un tool d'écriture.
    const writeOnly = await client(fakeComposio({ tools: [{ slug: "OUTLOOK_SEND_EMAIL" }, { slug: "OUTLOOK_DELETE_MESSAGE" }, { slug: "OUTLOOK_LIST_MAIL_FOLDERS" }] }).fetchImpl).listTools("outlook");
    expect(() => resolveOperation("list_recent", writeOnly)).toThrow(/Aucun tool autorisé .* list_recent .*OUTLOOK_LIST_MESSAGES/);
    expect(() => resolveOperation("search", writeOnly)).toThrow(/OUTLOOK_LIST_MAIL_FOLDERS/);
    // Un slug d'écriture glissé dans la table serait quand même refusé par les verbes.
    expect(OPERATION_TOOLS.get_attachment).toEqual(["OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT"]);
    const forged = [...full, { ...full[0]!, slug: "OUTLOOK_DELETE_MESSAGE" }];
    expect(() => assertReadOnlySlug("OUTLOOK_DELETE_MESSAGE", forged, "get_message")).toThrow(/refusé/);
  });

  it("exécution : seules les opérations de lecture existent ; la route rejette toute autre opération", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    fake.accounts.get(connectedAccountId)!.status = "ACTIVE";
    await refreshComposioConnection(a, { db, client: c });
    for (const [op, args] of [["list_recent", { limit: 5 }], ["search", { query: "devis" }], ["get_message", { message_id: "m1" }], ["list_attachments", { message_id: "m1" }], ["get_attachment", { message_id: "m1", attachment_id: "a1" }], ["list_events", { start: "2026-09-18T00:00:00Z", end: "2026-10-02T00:00:00Z" }]] as const) {
      const r = await runPocRead(a, op, args as Record<string, unknown>, { db, client: c });
      expect(r.ok).toBe(true);
      expect(r.tool).not.toMatch(/SEND|REPLY|FORWARD|DELETE|MOVE|CREATE|UPDATE|MARK|UPLOAD/);
    }
    const executedSlugs = fake.executed.map((e) => e.slug);
    expect(executedSlugs.every((s) => !/SEND|REPLY|FORWARD|DELETE|MOVE|CREATE|UPDATE|MARK|UPLOAD|BATCH/.test(s))).toBe(true);
    // Le contenu binaire d'une pièce jointe n'est jamais renvoyé tel quel.
    const att = await runPocRead(a, "get_attachment", { message_id: "m1", attachment_id: "a1" }, { db, client: c });
    expect(JSON.stringify(att.data)).toContain("contenu binaire");
    expect(JSON.stringify(att.data)).not.toContain("AAAAAAAAAAAAAAAAAAAA");
    // Aucune opération d'écriture n'existe côté service (TypeScript) ni côté route (zod).
    // @ts-expect-error — opération inexistante : refusée par le typage
    await expect(runPocRead(a, "send_email", {}, { db, client: c })).rejects.toThrow();
    const { z } = await import("zod");
    const schema = z.discriminatedUnion("operation", [z.object({ operation: z.literal("list_recent") })]);
    expect(schema.safeParse({ operation: "send_email" }).success).toBe(false);
  });

  it("input_parameters v3.1 (mapping direct) et forme JSON Schema : noms et paramètres requis détectés", async () => {
    // Forme documentée v3.1.
    expect(parseInputParameters({ repo_name: { type: "string", description: "…", required: true, example: "octocat/Hello-World" }, workflow_id: { type: "string", required: true }, ref: { type: "string", required: false } })).toEqual({ names: ["repo_name", "workflow_id", "ref"], required: ["repo_name", "workflow_id"] });
    // Forme JSON Schema, acceptée par robustesse.
    expect(parseInputParameters({ type: "object", properties: { message_id: { type: "string" }, top: { type: "integer" } }, required: ["message_id"] })).toEqual({ names: ["message_id", "top"], required: ["message_id"] });
    expect(parseInputParameters(undefined)).toEqual({ names: [], required: [] });
    expect(parseInputParameters({})).toEqual({ names: [], required: [] });
    // Via le faux serveur v3.1 : sanitizeTool expose exactement ce que Composio déclare.
    const tools = await client(fakeComposio().fetchImpl).listTools("outlook");
    const search = tools.find((t) => t.slug === "OUTLOOK_SEARCH_MESSAGES")!;
    expect(search.inputParameters).toEqual(["search", "top"]);
    expect(search.requiredParameters).toEqual(["search"]);
    const download = tools.find((t) => t.slug === "OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT")!;
    expect(download.requiredParameters).toEqual(["message_id", "attachment_id"]);
    expect(tools.find((t) => t.slug === "OUTLOOK_GET_PROFILE")!.inputParameters).toEqual([]);
  });

  it("arguments : shapeArguments suit le schéma Composio réellement déclaré", async () => {
    const tools = await client(fakeComposio().fetchImpl).listTools("outlook");
    const search = tools.find((t) => t.slug === "OUTLOOK_SEARCH_MESSAGES")!;
    expect(shapeArguments(search, { query: "devis", limit: 5, message_id: "ignoré" })).toEqual({ search: "devis", top: 5 });
    const query = tools.find((t) => t.slug === "OUTLOOK_QUERY_EMAILS")!;
    expect(shapeArguments(query, { query: "devis", limit: 5 })).toEqual({ query: "devis", max_results: 5 });
    const events = tools.find((t) => t.slug === "OUTLOOK_LIST_EVENTS")!;
    expect(shapeArguments(events, { start: "2026-09-18T00:00:00Z", end: "2026-10-02T00:00:00Z", limit: 5 })).toEqual({ start_datetime: "2026-09-18T00:00:00Z", end_datetime: "2026-10-02T00:00:00Z", top: 5 });
    const tool = { slug: "X", name: "", description: "", toolkit: "outlook", scopes: [], tags: [], deprecated: false, inputParameters: ["maxResults", "q"], requiredParameters: ["q"] };
    expect(shapeArguments(tool, { query: "devis", limit: 5 })).toEqual({ q: "devis", maxResults: 5 });
    expect(findEmail({ data: { userPrincipalName: "dirigeant@3t.fr" } })).toBe("dirigeant@3t.fr");
    expect(findEmail({ mail: "pas-un-email" })).toBeNull();
  });

  it("sanitizeAccount ignore tout secret renvoyé par Composio", () => {
    const account = sanitizeAccount({ id: "ca_1", status: "ACTIVE", state: { authScheme: "OAUTH2", val: { access_token: FAKE_TOKEN } }, data: { access_token: FAKE_TOKEN }, params: { client_secret: "cs" }, toolkit: { slug: "outlook" }, requested_scopes: ["Mail.Read"] });
    expect(JSON.stringify(account)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(account)).not.toContain("client_secret");
    expect(account).toMatchObject({ id: "ca_1", status: "ACTIVE", toolkit: "outlook", requestedScopes: ["Mail.Read"] });
  });

  it("la requête Composio porte la clé en en-tête, jamais dans l'URL ni le corps ; URL officielle par défaut, surchargeable", async () => {
    const fake = fakeComposio();
    await client(fake.fetchImpl).listTools("outlook");
    const call = fake.calls[0] as RecordedCall;
    expect(call.headers["x-api-key"]).toBe(FAKE_KEY);
    expect(call.url).toMatch(/^https:\/\/backend\.composio\.dev\/api\/v3\.1\/tools\?/);
    expect(call.url).not.toContain(FAKE_KEY);
    expect(JSON.stringify(call.body ?? {})).not.toContain(FAKE_KEY);
    expect(DEFAULT_COMPOSIO_BASE_URL).toBe("https://backend.composio.dev");
    const byDefault = new ComposioClient({ apiKey: FAKE_KEY, fetchImpl: fake.fetchImpl });
    await byDefault.listTools("outlook");
    expect(fake.calls.at(-1)?.url).toMatch(/^https:\/\/backend\.composio\.dev\//);
    // Surcharge par variable d'environnement (tests / staging).
    setEnv("COMPOSIO_BASE_URL", "https://staging-backend.composio.dev");
    resetEnvCache();
    await createComposioClient(fake.fetchImpl).listTools("outlook");
    expect(fake.calls.at(-1)?.url).toMatch(/^https:\/\/staging-backend\.composio\.dev\/api\/v3\.1\//);
    setEnv("COMPOSIO_BASE_URL", undefined);
    resetEnvCache();
  });
});

describe("POC Composio — retour OAuth : mode local (développement) et Callback Identity Verification", () => {
  let db: Db;
  let a: ReturnType<typeof users.createUser>;
  let b: ReturnType<typeof users.createUser>;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = openIsolatedDb();
    resetComposioPocForTests();
    for (const k of ["NODE_ENV", "COMPOSIO_POC_ENABLED", "COMPOSIO_API_KEY", "COMPOSIO_CALLBACK_VERIFICATION"]) saved[k] = process.env[k];
    setEnv("COMPOSIO_POC_ENABLED", "true");
    setEnv("COMPOSIO_API_KEY", FAKE_KEY);
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", undefined);
    resetEnvCache();
    a = users.createUser({ email: "a@3t.fr" }, db);
    b = users.createUser({ email: "b@3t.fr" }, db);
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) setEnv(k, v);
    resetEnvCache();
  });

  it("développement sans vérification : mode local toléré, callback_url transmis, avertissement affiché", async () => {
    setEnv("NODE_ENV", "development");
    resetEnvCache();
    expect(resolveCallbackMode()).toBe("local");
    const state = getPocState(a, db);
    expect(state.callbackMode).toBe("local");
    expect(state.callbackWarning).toBe(LOCAL_CALLBACK_WARNING);
    expect(state.configured).toBe(true);
    const fake = fakeComposio();
    const r = await startComposioConnection(a, "https://ema.test/api/poc/composio/callback", { db, client: client(fake.fetchImpl) });
    expect(r.callbackMode).toBe("local");
    const link = fake.calls.find((c) => c.url.endsWith("/connected_accounts/link"))!;
    expect((link.body as Record<string, unknown>).callback_url).toBe("https://ema.test/api/poc/composio/callback");
  });

  it("production sans vérification : fail-closed, aucune connexion démarrée, aucun appel Composio", async () => {
    setEnv("NODE_ENV", "production");
    resetEnvCache();
    expect(() => resolveCallbackMode()).toThrow(/Callback Identity Verification obligatoire en production/);
    const state = getPocState(a, db);
    expect(state.configured).toBe(false);
    expect(state.configError).toMatch(/obligatoire en production/);
    const fake = fakeComposio();
    await expect(startComposioConnection(a, "https://ema.test/cb", { db, client: client(fake.fetchImpl) })).rejects.toMatchObject({ code: "CONFIG" });
    expect(fake.calls).toHaveLength(0);
    expect(getComposioConnection(a.id, db)).toBeUndefined();
  });

  it("production avec vérification : mode vérifié, aucun callback_url transmis (verifier URL du projet Composio)", async () => {
    setEnv("NODE_ENV", "production");
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", "true");
    resetEnvCache();
    expect(resolveCallbackMode()).toBe("verified");
    expect(getPocState(a, db)).toMatchObject({ configured: true, callbackMode: "verified", callbackWarning: null });
    const fake = fakeComposio();
    const r = await startComposioConnection(a, "https://ema.test/cb", { db, client: client(fake.fetchImpl) });
    expect(r.callbackMode).toBe("verified");
    const link = fake.calls.find((c) => c.url.endsWith("/connected_accounts/link"))!;
    expect(link.body).toEqual({ auth_config_id: "ac_outlook_ro", user_id: a.id });
  });

  it("complete_auth : l'utilisateur de session correspond → connexion ACTIVE", async () => {
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", "true");
    resetEnvCache();
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    fake.sessions.set("https://backend.composio.dev/session/abc", { accountId: connectedAccountId, ownerUserId: a.id });
    const state = await completeComposioCallback(a, "https://backend.composio.dev/session/abc", { db, client: c });
    expect(state.status).toBe("connected");
    const call = fake.calls.find((x) => x.url.endsWith("/connected_accounts/complete_auth"))!;
    expect(call.body).toEqual({ session_uri: "https://backend.composio.dev/session/abc", user_id: a.id });
    expect(call.headers["x-api-key"]).toBe(FAKE_KEY);
    expect(listHistory({ limit: 10, userId: a.id }, db).some((h) => h.event_type === "composio.identity_verified")).toBe(true);
    // Le session_uri est à usage unique : une seconde consommation échoue proprement.
    await expect(completeComposioCallback(a, "https://backend.composio.dev/session/abc", { db, client: c })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("session fixation : un autre utilisateur revient du parcours → refus, rien d'activé (sans état local : aucun appel ; avec son propre parcours : 400 Composio)", async () => {
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", "true");
    resetEnvCache();
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    // A démarre le parcours et transmet le lien ; B (authentifié dans EMA, sans parcours) revient sur le verifier URL.
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    fake.sessions.set("https://backend.composio.dev/session/fix", { accountId: connectedAccountId, ownerUserId: a.id });
    await expect(completeComposioCallback(b, "https://backend.composio.dev/session/fix", { db, client: c })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.calls.filter((x) => x.url.endsWith("/connected_accounts/complete_auth"))).toHaveLength(0); // refus local, avant Composio
    expect(fake.accounts.get(connectedAccountId)?.status).toBe("INITIATED"); // rien d'activé
    expect(getComposioConnection(b.id, db)).toBeUndefined();

    // Variante : B a démarré SON propre parcours (état local en attente) puis termine le lien de A.
    const own = await startComposioConnection(b, "https://ema.test/cb", { db, client: c });
    await expect(completeComposioCallback(b, "https://backend.composio.dev/session/fix", { db, client: c })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const call = fake.calls.find((x) => x.url.endsWith("/connected_accounts/complete_auth"))!;
    expect(call.body).toEqual({ session_uri: "https://backend.composio.dev/session/fix", user_id: b.id });
    expect(fake.accounts.get(connectedAccountId)?.status).toBe("FAILED"); // Composio : identité différente
    expect(fake.accounts.get(own.connectedAccountId)?.status).toBe("INITIATED"); // le parcours de B n'est pas activé
    expect(getComposioConnection(b.id, db)?.status).toBe("FAILED");
    expect(getComposioConnection(b.id, db)?.connected_account_id).toBe(own.connectedAccountId);
    expect((await refreshComposioConnection(a, { db, client: c })).status).toBe("error");
    expect(getPocState(a, db).statusReason).toMatch(/identity verification failed/i);
    expect(fake.executed).toHaveLength(0);
  });

  it("complete_auth : session inconnue ou expirée → 404 traduit, référence conservée", async () => {
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", "true");
    resetEnvCache();
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    await expect(completeComposioCallback(a, "https://backend.composio.dev/session/expired", { db, client: c })).rejects.toThrow(/expirée .* ou déjà utilisée/);
    expect(getComposioConnection(a.id, db)?.status).toBe("INITIATED");
    await expect(completeComposioCallback(a, "javascript:alert(1)", { db, client: c })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("complete_auth : compte activé différent de la référence → refus, compte étranger révoqué, référence locale jamais remplacée", async () => {
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", "true");
    resetEnvCache();
    const fake = fakeComposio({ accounts: [{ id: "ca_other", status: "INITIATED", user_id: a.id }] });
    const c = client(fake.fetchImpl);
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    fake.sessions.set("https://backend.composio.dev/session/other", { accountId: "ca_other", ownerUserId: a.id });
    await expect(completeComposioCallback(a, "https://backend.composio.dev/session/other", { db, client: c })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Le compte activé par Composio (ca_other) est immédiatement supprimé + révoqué.
    expect(fake.calls.some((x) => x.method === "DELETE" && x.url.includes("/connected_accounts/ca_other") && x.url.includes("revoke_on_delete=true"))).toBe(true);
    expect(fake.accounts.has("ca_other")).toBe(false);
    // La référence locale garde l'identifiant démarré, en erreur ; jamais remplacée par ca_other.
    const row = getComposioConnection(a.id, db)!;
    expect(row.connected_account_id).toBe(connectedAccountId);
    expect(row.status).toBe("FAILED");
    expect(row.status_reason).toMatch(/connected account mismatch/);
    expect(row.last_error).toMatch(/révoqué/);
    expect(listHistory({ limit: 10, userId: a.id }, db).some((h) => h.event_type === "composio.identity_rejected")).toBe(true);
    // Aucune lecture possible ensuite.
    await expect(runPocRead(a, "list_recent", {}, { db, client: c })).rejects.toMatchObject({ code: "MICROSOFT_RECONNECT" });
  });

  it("complete_auth : échec de révocation du compte étranger → refus maintenu, échec journalisé sans secret", async () => {
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", "true");
    resetEnvCache();
    const inner = fakeComposio({ accounts: [{ id: "ca_other", status: "INITIATED", user_id: a.id }] });
    // DELETE de ca_other échoue (500) ; tout le reste passe par le faux serveur.
    const failingDelete: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method ?? "GET") === "DELETE" && url.includes("/connected_accounts/ca_other")) return json({ error: { message: "internal" } }, 500);
      return inner.fetchImpl(input, init);
    };
    const c = client(failingDelete);
    const lines: string[] = [];
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
    try {
      const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
      inner.sessions.set("https://backend.composio.dev/session/other2", { accountId: "ca_other", ownerUserId: a.id });
      await expect(completeComposioCallback(a, "https://backend.composio.dev/session/other2", { db, client: c })).rejects.toMatchObject({ code: "FORBIDDEN" });
      const row = getComposioConnection(a.id, db)!;
      expect(row.connected_account_id).toBe(connectedAccountId);
      expect(row.status).toBe("FAILED");
      expect(row.last_error).toMatch(/NON révoqué/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const logged = lines.join("\n");
    expect(logged).toMatch(/could NOT be revoked/);
    expect(logged).not.toContain(FAKE_KEY);
    expect(logged).not.toContain(FAKE_TOKEN);
  });

  it("callback vérifié sans connexion locale en attente → refus AVANT tout appel complete_auth, rien d'activé, aucune référence créée", async () => {
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", "true");
    resetEnvCache();
    // Un compte pending existe chez Composio pour B (démarré hors EMA, ou état local perdu) : EMA n'en a aucune trace.
    const fake = fakeComposio({ accounts: [{ id: "ca_pending_b", status: "INITIATED", user_id: b.id }] });
    const c = client(fake.fetchImpl);
    fake.sessions.set("https://backend.composio.dev/session/norow", { accountId: "ca_pending_b", ownerUserId: b.id });
    await expect(completeComposioCallback(b, "https://backend.composio.dev/session/norow", { db, client: c })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fake.calls.filter((x) => x.url.endsWith("/connected_accounts/complete_auth"))).toHaveLength(0);
    expect(fake.accounts.get("ca_pending_b")?.status).toBe("INITIATED"); // jamais activé
    expect(fake.sessions.has("https://backend.composio.dev/session/norow")).toBe(true); // session non consommée
    expect(getComposioConnection(b.id, db)).toBeUndefined();
    expect(listHistory({ limit: 10, userId: b.id }, db).some((h) => h.event_type === "composio.identity_rejected" && /aucune connexion en attente/.test(h.message))).toBe(true);
    // Connexion locale existante mais plus en attente (déjà ACTIVE) : refus également, sans appel.
    const { connectedAccountId } = await startComposioConnection(a, "https://ema.test/cb", { db, client: c });
    updateComposioConnection(a.id, { status: "ACTIVE" }, db);
    fake.sessions.set("https://backend.composio.dev/session/again", { accountId: connectedAccountId, ownerUserId: a.id });
    await expect(completeComposioCallback(a, "https://backend.composio.dev/session/again", { db, client: c })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.calls.filter((x) => x.url.endsWith("/connected_accounts/complete_auth"))).toHaveLength(0);
  });

  it("route callback : mode vérifié sans session_uri → refus sans appel ; mode local avec session_uri → non consommé, incohérence signalée", async () => {
    const { GET } = await import("@/app/api/poc/composio/callback/route");
    // Mode vérifié, utilisateur de session A, aucun session_uri.
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", "true");
    setEnv("APP_URL", "https://ema.test");
    resetEnvCache();
    const fake = fakeComposio();
    const { setComposioClientForTests } = await import("@/integrations/composio/outlook-poc");
    setComposioClientForTests(client(fake.fetchImpl));
    // La route travaille sur la base globale du process : l'utilisateur et sa connexion y sont créés.
    const { getDb } = await import("@/database/connection");
    const ra = users.getUserByEmail("route-a@3t.fr", getDb()) ?? users.createUser({ email: "route-a@3t.fr" }, getDb());
    try {
      const { connectedAccountId } = await startComposioConnection(ra, "https://ema.test/cb");
      sessionUserRef.current = ra;
      const res1 = await GET(new Request("https://ema.test/api/poc/composio/callback"), {});
      expect(res1.status).toBe(302);
      const errorOf = (res: Response) => new URL(res.headers.get("location") ?? "https://x/").searchParams.get("error") ?? "";
      expect(errorOf(res1)).toMatch(/session_uri absent/);
      expect(fake.calls.filter((x) => x.url.endsWith("/connected_accounts/complete_auth"))).toHaveLength(0);

      // Mode local (développement) avec un session_uri inattendu : jamais consommé.
      setEnv("COMPOSIO_CALLBACK_VERIFICATION", "false");
      setEnv("NODE_ENV", "development");
      resetEnvCache();
      fake.sessions.set("https://backend.composio.dev/session/unexpected", { accountId: connectedAccountId, ownerUserId: ra.id });
      const res2 = await GET(new Request("https://ema.test/api/poc/composio/callback?session_uri=https%3A%2F%2Fbackend.composio.dev%2Fsession%2Funexpected"), {});
      expect(res2.status).toBe(302);
      expect(errorOf(res2)).toMatch(/Incohérence de configuration/);
      expect(fake.calls.filter((x) => x.url.endsWith("/connected_accounts/complete_auth"))).toHaveLength(0);
      expect(fake.sessions.has("https://backend.composio.dev/session/unexpected")).toBe(true);
      expect(fake.accounts.get(connectedAccountId)?.status).toBe("INITIATED");

      // Mode local sans session_uri : simple relecture du statut.
      fake.accounts.get(connectedAccountId)!.status = "ACTIVE";
      const res3 = await GET(new Request("https://ema.test/api/poc/composio/callback"), {});
      expect(new URL(res3.headers.get("location") ?? "https://x/").searchParams.get("status")).toBe("connected");
      expect(fake.calls.filter((x) => x.url.endsWith("/connected_accounts/complete_auth"))).toHaveLength(0);

      // Sans session EMA : redirection vers la connexion, rien consommé.
      sessionUserRef.current = null;
      const res4 = await GET(new Request("https://ema.test/api/poc/composio/callback?session_uri=https%3A%2F%2Fbackend.composio.dev%2Fsession%2Funexpected"), {});
      expect(res4.headers.get("location")).toMatch(/\/login\?error=/);
      expect(fake.calls.filter((x) => x.url.endsWith("/connected_accounts/complete_auth"))).toHaveLength(0);
    } finally {
      sessionUserRef.current = null;
      setComposioClientForTests(null);
      setEnv("APP_URL", undefined);
      await disconnectComposio(ra).catch(() => undefined);
    }
  });

  it("scopes Managed OAuth lecture seule : chaîne séparée par des virgules, sans aucun scope d'écriture", () => {
    expect(managedOAuthScopes()).toBe("openid,profile,offline_access,User.Read,Mail.Read,Calendars.Read");
    expect(managedOAuthScopes()).not.toMatch(/\s/);
    for (const forbidden of ["Mail.Send", "Mail.ReadWrite", "Calendars.ReadWrite", "Files.ReadWrite", ".Write"]) expect(managedOAuthScopes()).not.toContain(forbidden);
    expect([...POC_READ_ONLY_SCOPES]).toEqual(["openid", "profile", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"]);
  });
});

describe("POC Composio — preflight, smoke test guidé, invariant WRITE = 0", () => {
  let db: Db;
  const saved: Record<string, string | undefined> = {};
  const VARS = ["NODE_ENV", "APP_URL", "APP_SECRET", "COMPOSIO_POC_ENABLED", "COMPOSIO_API_KEY", "COMPOSIO_OUTLOOK_AUTH_CONFIG_ID", "COMPOSIO_BASE_URL", "COMPOSIO_CALLBACK_VERIFICATION", "MICROSOFT_CLIENT_SECRET", "WHATSAPP_ACCESS_TOKEN", "ANTHROPIC_API_KEY"];
  /** Faux secrets : servent uniquement à prouver qu'aucune valeur ne sort du preflight. */
  const FAKE_AUTH_CONFIG_ID = "ac_fake_outlook_readonly_0000";
  const FAKE_CLIENT_SECRET = "microsoft-client-secret-NEVER-SHOWN";
  const FAKE_WA_TOKEN = "whatsapp-token-NEVER-SHOWN";
  const FAKE_APP_SECRET = "app-secret-32-characters-long-NEVER-SHOWN";

  beforeEach(() => {
    db = openIsolatedDb();
    resetComposioPocForTests();
    for (const k of VARS) saved[k] = process.env[k];
    sessionUserRef.current = null;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) setEnv(k, v);
    resetEnvCache();
    sessionUserRef.current = null;
  });

  function configureFake(overrides: Record<string, string | undefined> = {}) {
    setEnv("NODE_ENV", "development");
    setEnv("APP_URL", "https://ema.test");
    setEnv("APP_SECRET", FAKE_APP_SECRET);
    setEnv("COMPOSIO_POC_ENABLED", "true");
    setEnv("COMPOSIO_API_KEY", FAKE_KEY);
    setEnv("COMPOSIO_OUTLOOK_AUTH_CONFIG_ID", FAKE_AUTH_CONFIG_ID);
    setEnv("COMPOSIO_BASE_URL", undefined);
    setEnv("COMPOSIO_CALLBACK_VERIFICATION", "true");
    setEnv("MICROSOFT_CLIENT_SECRET", FAKE_CLIENT_SECRET);
    setEnv("WHATSAPP_ACCESS_TOKEN", FAKE_WA_TOKEN);
    setEnv("ANTHROPIC_API_KEY", undefined);
    for (const [k, v] of Object.entries(overrides)) setEnv(k, v);
    resetEnvCache();
  }

  it("preflight sans clé : COMPOSIO_API_KEY absente → FAIL, non prêt, aucune valeur exposée", async () => {
    configureFake({ COMPOSIO_API_KEY: undefined });
    const { runComposioPreflight } = await import("@/integrations/composio/preflight");
    const report = runComposioPreflight({ db });
    expect(report.ready).toBe(false);
    const byKey = Object.fromEntries(report.checks.map((c) => [c.key, c]));
    expect(byKey.api_key).toMatchObject({ level: "FAIL", detail: expect.stringMatching(/absente/) });
    expect(byKey.poc_enabled?.level).toBe("OK");
    expect(byKey.db?.level).toBe("OK");
    expect(byKey.migration?.level).toBe("OK");
  });

  it("preflight correctement configuré (fausses variables) : tout OK, mode vérifié, 8 tools attendus, 4 capacités de lecture", async () => {
    configureFake();
    const { runComposioPreflight, expectedExecutableToolCount, nativeGraphIntact, POC_CAPABILITIES } = await import("@/integrations/composio/preflight");
    const report = runComposioPreflight({ db });
    expect(report.ready).toBe(true);
    expect(report.callbackMode).toBe("verified");
    expect(report.baseUrl).toBe(DEFAULT_COMPOSIO_BASE_URL);
    expect(report.expectedExecutableTools).toBe(8);
    expect(expectedExecutableToolCount()).toBe([...new Set(Object.values(OPERATION_TOOLS).flat())].length);
    expect([...report.capabilities]).toEqual(["email.read", "email.search", "attachment.read", "calendar.read"]);
    expect([...POC_CAPABILITIES]).toEqual([...report.capabilities]);
    expect([...report.readOnlyScopes]).toEqual([...POC_READ_ONLY_SCOPES]);
    const byKey = Object.fromEntries(report.checks.map((c) => [c.key, c]));
    for (const key of ["poc_enabled", "api_key", "auth_config_id", "callback_mode", "production_safety", "app_url", "base_url", "db", "migration", "native_graph", "env_blocking", "executable_tools", "capabilities"]) {
      expect(byKey[key]?.level, key).toBe("OK");
    }
    expect(byKey.api_key?.detail).toBe("présente");
    expect(byKey.auth_config_id?.detail).toBe("présent");
    expect(byKey.app_url?.detail).toContain("https://ema.test/api/poc/composio/callback");
    expect(byKey.migration?.detail).toMatch(/composio_connections/);
    expect(nativeGraphIntact().intact).toBe(true);
    expect(byKey.native_graph?.detail).toContain("Mail.Send"); // Graph natif conserve ses scopes : le POC n'y touche pas
    // Auth config absente : avertissement seulement (découverte automatique) ; base sans HTTPS : échec.
    configureFake({ COMPOSIO_OUTLOOK_AUTH_CONFIG_ID: undefined, COMPOSIO_BASE_URL: "http://composio.local" });
    const r2 = runComposioPreflight({ db });
    const k2 = Object.fromEntries(r2.checks.map((c) => [c.key, c]));
    expect(k2.auth_config_id?.level).toBe("WARN");
    expect(k2.base_url?.level).toBe("FAIL");
    expect(r2.ready).toBe(false);
  });

  it("preflight : aucune valeur de secret dans la réponse (clé, auth config, secret client, token WhatsApp, APP_SECRET), route authentifiée", async () => {
    configureFake();
    const { runComposioPreflight } = await import("@/integrations/composio/preflight");
    const serialized = JSON.stringify(runComposioPreflight({ db }));
    for (const secret of [FAKE_KEY, FAKE_AUTH_CONFIG_ID, FAKE_CLIENT_SECRET, FAKE_WA_TOKEN, FAKE_APP_SECRET, FAKE_TOKEN]) expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/access_token|refresh_token|client_secret/i);

    const { GET } = await import("@/app/api/poc/composio/preflight/route");
    // Sans session : 401, aucun contenu de preflight.
    const anon = await GET(new Request("https://ema.test/api/poc/composio/preflight"), {});
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain("checks");
    // Avec session : réponse complète, toujours sans secret.
    const { getDb } = await import("@/database/connection");
    const u = users.getUserByEmail("preflight@3t.fr", getDb()) ?? users.createUser({ email: "preflight@3t.fr" }, getDb());
    sessionUserRef.current = u;
    const res = await GET(new Request("https://ema.test/api/poc/composio/preflight"), {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"ready":true');
    for (const secret of [FAKE_KEY, FAKE_AUTH_CONFIG_ID, FAKE_CLIENT_SECRET, FAKE_WA_TOKEN, FAKE_APP_SECRET]) expect(text).not.toContain(secret);
  });

  it("WRITE tools executable = 0 : résumé du diagnostic, route tools, invariant même avec un catalogue hostile", async () => {
    configureFake();
    const { summarizeTools, classifyTools, WRITE_VERBS } = await import("@/integrations/composio/policy");
    const fake = fakeComposio();
    const { allowed, readOnlyUnused, blocked } = await listPocTools({ db, client: client(fake.fetchImpl) });
    const summary = summarizeTools({ allowed, readOnlyUnused, blocked });
    expect(summary).toMatchObject({ executable: 8, writeToolsExecutable: 0, writeToolsExecutableSlugs: [], pocFailed: false });
    expect(summary.blocked).toBeGreaterThan(0);
    expect(allowed.some((t) => WRITE_VERBS.test(t.slug))).toBe(false);

    // Catalogue hostile : tools d'écriture déguisés (verbe de lecture + verbe d'écriture, slug autorisé mais déprécié, autre toolkit).
    const hostile = [
      ...CURRENT_OUTLOOK_CATALOGUE,
      { slug: "OUTLOOK_GET_AND_DELETE_MESSAGE" },
      { slug: "OUTLOOK_LIST_MESSAGES_AND_SEND" },
      { slug: "OUTLOOK_READ_THEN_FORWARD" },
    ];
    resetComposioPocForTests();
    const fake2 = fakeComposio({ tools: hostile });
    const classified = classifyTools(await client(fake2.fetchImpl).listTools("outlook"));
    const s2 = summarizeTools(classified);
    expect(s2.writeToolsExecutable).toBe(0);
    expect(s2.pocFailed).toBe(false);
    expect(classified.blocked.map((t) => t.slug)).toEqual(expect.arrayContaining(["OUTLOOK_GET_AND_DELETE_MESSAGE", "OUTLOOK_LIST_MESSAGES_AND_SEND", "OUTLOOK_READ_THEN_FORWARD"]));
    // Un exécutable d'écriture (impossible par construction) serait détecté comme échec du POC.
    const forged = { ...classified, allowed: [...classified.allowed, { ...classified.allowed[0]!, slug: "OUTLOOK_SEND_EMAIL" }] };
    expect(summarizeTools(forged)).toMatchObject({ writeToolsExecutable: 1, writeToolsExecutableSlugs: ["OUTLOOK_SEND_EMAIL"], pocFailed: true });

    // Route diagnostic : trois catégories + résumé.
    const { GET } = await import("@/app/api/poc/composio/tools/route");
    const { setComposioClientForTests } = await import("@/integrations/composio/outlook-poc");
    resetComposioPocForTests();
    setComposioClientForTests(client(fake.fetchImpl));
    const { getDb } = await import("@/database/connection");
    sessionUserRef.current = users.getUserByEmail("tools@3t.fr", getDb()) ?? users.createUser({ email: "tools@3t.fr" }, getDb());
    try {
      const res = await GET(new Request("https://ema.test/api/poc/composio/tools"), {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { allowed: unknown[]; readOnlyUnused: unknown[]; blocked: unknown[]; summary: { writeToolsExecutable: number; pocFailed: boolean } } };
      expect(body.data.summary).toMatchObject({ writeToolsExecutable: 0, pocFailed: false });
      expect(body.data.allowed).toHaveLength(8);
      expect(body.data.readOnlyUnused.length).toBeGreaterThan(0);
      expect(body.data.blocked.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
    } finally {
      setComposioClientForTests(null);
    }
  });

  it("page smoke test inaccessible sans session : page → UNAUTHORIZED, routes preflight/tools/status → 401", async () => {
    configureFake();
    sessionUserRef.current = null;
    const page = (await import("@/app/(app)/poc/composio/page")).default;
    await expect(page({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    for (const path of ["preflight", "tools", "status"]) {
      const { GET } = await import(`@/app/api/poc/composio/${path}/route`);
      const res = await GET(new Request(`https://ema.test/api/poc/composio/${path}`), {});
      expect(res.status, path).toBe(401);
    }
  });

  it("POC désactivé : page introuvable (notFound), routes preflight/tools → 404, preflight le signale", async () => {
    configureFake({ COMPOSIO_POC_ENABLED: "false" });
    const { runComposioPreflight } = await import("@/integrations/composio/preflight");
    const report = runComposioPreflight({ db });
    expect(report.ready).toBe(false);
    expect(report.checks.find((c) => c.key === "poc_enabled")).toMatchObject({ level: "FAIL" });
    const { getDb } = await import("@/database/connection");
    sessionUserRef.current = users.getUserByEmail("off@3t.fr", getDb()) ?? users.createUser({ email: "off@3t.fr" }, getDb());
    const page = (await import("@/app/(app)/poc/composio/page")).default;
    await expect(page({ searchParams: Promise.resolve({}) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    for (const path of ["preflight", "tools"]) {
      const { GET } = await import(`@/app/api/poc/composio/${path}/route`);
      const res = await GET(new Request(`https://ema.test/api/poc/composio/${path}`), {});
      expect(res.status, path).toBe(404);
    }
  });

  it("callback verified incohérent → fail closed : production sans vérification refuse tout, session_uri jamais consommé", async () => {
    // Production + COMPOSIO_CALLBACK_VERIFICATION=false : preflight FAIL, route callback refuse sans appel Composio.
    configureFake({ NODE_ENV: "production", COMPOSIO_CALLBACK_VERIFICATION: "false" });
    const { runComposioPreflight } = await import("@/integrations/composio/preflight");
    const report = runComposioPreflight({ db });
    expect(report.ready).toBe(false);
    expect(report.callbackMode).toBeNull();
    expect(report.checks.find((c) => c.key === "production_safety")).toMatchObject({ level: "FAIL", detail: expect.stringMatching(/obligatoire en production/) });

    const { GET } = await import("@/app/api/poc/composio/callback/route");
    const { setComposioClientForTests } = await import("@/integrations/composio/outlook-poc");
    const fake = fakeComposio({ accounts: [{ id: "ca_prod", status: "INITIATED", user_id: "someone" }] });
    fake.sessions.set("https://backend.composio.dev/session/prod", { accountId: "ca_prod", ownerUserId: "someone" });
    setComposioClientForTests(client(fake.fetchImpl));
    const { getDb } = await import("@/database/connection");
    sessionUserRef.current = users.getUserByEmail("prod@3t.fr", getDb()) ?? users.createUser({ email: "prod@3t.fr" }, getDb());
    try {
      const res = await GET(new Request("https://ema.test/api/poc/composio/callback?session_uri=https%3A%2F%2Fbackend.composio.dev%2Fsession%2Fprod"), {});
      expect(res.status).toBe(302);
      const error = new URL(res.headers.get("location") ?? "https://x/").searchParams.get("error") ?? "";
      expect(error).toMatch(/obligatoire en production/);
      expect(fake.calls).toHaveLength(0);
      expect(fake.sessions.has("https://backend.composio.dev/session/prod")).toBe(true);
      expect(fake.accounts.get("ca_prod")?.status).toBe("INITIATED");
      expect(error).not.toContain(FAKE_KEY);

      // Mode vérifié, session_uri présent mais aucun parcours démarré depuis EMA : refus avant complete_auth.
      configureFake({ NODE_ENV: "production", COMPOSIO_CALLBACK_VERIFICATION: "true" });
      const res2 = await GET(new Request("https://ema.test/api/poc/composio/callback?session_uri=https%3A%2F%2Fbackend.composio.dev%2Fsession%2Fprod"), {});
      expect(new URL(res2.headers.get("location") ?? "https://x/").searchParams.get("error")).toMatch(/aucune connexion|Aucune connexion/);
      expect(fake.calls.filter((c) => c.url.endsWith("/connected_accounts/complete_auth"))).toHaveLength(0);
      expect(fake.sessions.has("https://backend.composio.dev/session/prod")).toBe(true);
    } finally {
      setComposioClientForTests(null);
    }
  });
});
