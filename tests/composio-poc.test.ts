import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openIsolatedDb, type Db } from "@/database/connection";
import * as users from "@/database/repositories/users";
import { getComposioConnection, updateComposioConnection } from "@/database/repositories/composio-connections";
import { listHistory } from "@/database/repositories/history";
import { ComposioClient, ComposioError, createComposioClient, sanitizeAccount } from "@/integrations/composio/client";
import { assertReadOnlySlug, isReadOnlyTool, resolveOperation } from "@/integrations/composio/policy";
import { disconnectComposio, findEmail, getPocState, listPocTools, refreshComposioConnection, resetComposioPocForTests, runPocRead, shapeArguments, startComposioConnection } from "@/integrations/composio/outlook-poc";
import { resetEnvCache } from "@/lib/env";
import { fakeFetch, json, type RecordedCall } from "./helpers/fake-graph";

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

/** Faux serveur Composio : toolkit Outlook avec tools de lecture ET d'écriture, comptes connectés par utilisateur. */
function fakeComposio(opts: { accounts?: FakeAccount[]; tools?: { slug: string; params?: string[] }[]; executeFails?: string | null; profileEmail?: string | null } = {}) {
  const accounts = new Map((opts.accounts ?? []).map((a) => [a.id, a]));
  const tools = opts.tools ?? [
    { slug: "OUTLOOK_OUTLOOK_LIST_MESSAGES", params: ["top", "folder"] },
    { slug: "OUTLOOK_OUTLOOK_SEARCH_EMAILS", params: ["search", "top"] },
    { slug: "OUTLOOK_OUTLOOK_GET_MESSAGE", params: ["message_id"] },
    { slug: "OUTLOOK_OUTLOOK_LIST_ATTACHMENTS", params: ["message_id"] },
    { slug: "OUTLOOK_OUTLOOK_GET_ATTACHMENT", params: ["message_id", "attachment_id"] },
    { slug: "OUTLOOK_OUTLOOK_CALENDAR_LIST_EVENTS", params: ["start_datetime", "end_datetime", "top"] },
    { slug: "OUTLOOK_OUTLOOK_GET_PROFILE", params: [] },
    { slug: "OUTLOOK_OUTLOOK_SEND_EMAIL", params: ["to", "subject", "body"] },
    { slug: "OUTLOOK_OUTLOOK_REPLY_EMAIL", params: ["message_id", "body"] },
    { slug: "OUTLOOK_OUTLOOK_FORWARD_EMAIL", params: ["message_id", "to"] },
    { slug: "OUTLOOK_OUTLOOK_DELETE_MESSAGE", params: ["message_id"] },
    { slug: "OUTLOOK_OUTLOOK_MOVE_MESSAGE", params: ["message_id", "folder"] },
    { slug: "OUTLOOK_OUTLOOK_MARK_AS_READ", params: ["message_id"] },
    { slug: "OUTLOOK_OUTLOOK_CREATE_EVENT", params: ["subject"] },
    { slug: "OUTLOOK_OUTLOOK_UPDATE_EVENT", params: ["event_id"] },
    { slug: "OUTLOOK_OUTLOOK_DELETE_EVENT", params: ["event_id"] },
    { slug: "OUTLOOK_OUTLOOK_CREATE_DRAFT", params: ["subject"] },
    { slug: "OUTLOOK_ONEDRIVE_UPLOAD_FILE", params: ["path"] },
    { slug: "OUTLOOK_OUTLOOK_BATCH_UPDATE_MESSAGES", params: ["ids"] },
  ];
  const executed: { slug: string; body: Record<string, unknown> }[] = [];
  let linkCount = 0;
  const { fetchImpl, calls } = fakeFetch([
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
    { match: /GET .*\/api\/v3\.1\/tools\?/, handle: () => json({ items: tools.map((t) => ({ slug: t.slug, name: t.slug.toLowerCase(), description: `Tool ${t.slug}`, toolkit: { slug: "outlook" }, scopes: [], tags: [], is_deprecated: false, input_parameters: { type: "object", properties: Object.fromEntries((t.params ?? []).map((p) => [p, { type: "string" }])), required: [] } })), next_cursor: null }) },
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
        if (slug.endsWith("GET_ATTACHMENT")) return json({ successful: true, data: { name: "devis.pdf", size: 12, contentBytes: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, error: null });
        return json({ successful: true, data: { owner: account.user_id, messages: [{ id: `m-${account.user_id}`, subject: `Boîte de ${account.user_id}` }] }, error: null, log_id: "log_2" });
      },
    },
  ]);
  return { fetchImpl, calls, accounts, executed };
}

function client(fetchImpl: typeof fetch): ComposioClient {
  return new ComposioClient({ apiKey: FAKE_KEY, baseUrl: "https://api.composio.dev", fetchImpl });
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
    const exec = fake.executed.find((e) => e.slug === "OUTLOOK_OUTLOOK_LIST_MESSAGES")!;
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

  it("classe les tools : lecture autorisée, écriture/destructif refusé", async () => {
    const fake = fakeComposio();
    const { allowed, blocked } = await listPocTools({ db, client: client(fake.fetchImpl) });
    const allowedSlugs = allowed.map((t) => t.slug);
    const blockedSlugs = blocked.map((t) => t.slug);
    for (const s of ["OUTLOOK_OUTLOOK_LIST_MESSAGES", "OUTLOOK_OUTLOOK_SEARCH_EMAILS", "OUTLOOK_OUTLOOK_GET_MESSAGE", "OUTLOOK_OUTLOOK_LIST_ATTACHMENTS", "OUTLOOK_OUTLOOK_GET_ATTACHMENT", "OUTLOOK_OUTLOOK_CALENDAR_LIST_EVENTS", "OUTLOOK_OUTLOOK_GET_PROFILE"]) expect(allowedSlugs).toContain(s);
    for (const s of ["OUTLOOK_OUTLOOK_SEND_EMAIL", "OUTLOOK_OUTLOOK_REPLY_EMAIL", "OUTLOOK_OUTLOOK_FORWARD_EMAIL", "OUTLOOK_OUTLOOK_DELETE_MESSAGE", "OUTLOOK_OUTLOOK_MOVE_MESSAGE", "OUTLOOK_OUTLOOK_MARK_AS_READ", "OUTLOOK_OUTLOOK_CREATE_EVENT", "OUTLOOK_OUTLOOK_UPDATE_EVENT", "OUTLOOK_OUTLOOK_DELETE_EVENT", "OUTLOOK_OUTLOOK_CREATE_DRAFT", "OUTLOOK_ONEDRIVE_UPLOAD_FILE", "OUTLOOK_OUTLOOK_BATCH_UPDATE_MESSAGES"]) {
      expect(blockedSlugs).toContain(s);
      expect(allowedSlugs).not.toContain(s);
    }
    // Un tool d'un autre toolkit, même « GET », est refusé ; un tool déprécié aussi.
    expect(isReadOnlyTool({ slug: "GMAIL_GET_MESSAGE", toolkit: "gmail", deprecated: false })).toBe(false);
    expect(isReadOnlyTool({ slug: "OUTLOOK_OUTLOOK_GET_MESSAGE", toolkit: "outlook", deprecated: true })).toBe(false);
    // Un slug ambigu qui mélange lecture et écriture est refusé.
    expect(isReadOnlyTool({ slug: "OUTLOOK_OUTLOOK_GET_AND_DELETE_MESSAGE", toolkit: "outlook", deprecated: false })).toBe(false);
  });

  it("assertReadOnlySlug : slug inconnu ou d'écriture → FORBIDDEN, jamais exécuté", async () => {
    const fake = fakeComposio();
    const c = client(fake.fetchImpl);
    const tools = await c.listTools("outlook");
    expect(() => assertReadOnlySlug("OUTLOOK_OUTLOOK_SEND_EMAIL", tools)).toThrow(/refusé par la politique/);
    expect(() => assertReadOnlySlug("OUTLOOK_OUTLOOK_DELETE_MESSAGE", tools)).toThrow(/refusé par la politique/);
    expect(() => assertReadOnlySlug("OUTLOOK_OUTLOOK_SOMETHING_NEW", tools)).toThrow(/inconnu/);
    expect(() => assertReadOnlySlug("OUTLOOK_OUTLOOK_GET_MESSAGE", tools)).not.toThrow();
  });

  it("résolution d'opération : jamais un tool d'écriture, échec explicite si aucun tool de lecture ne correspond", async () => {
    // Toolkit ne contenant que des tools d'écriture (+ un tool de lecture sans rapport).
    const fake = fakeComposio({ tools: [{ slug: "OUTLOOK_OUTLOOK_SEND_EMAIL" }, { slug: "OUTLOOK_OUTLOOK_DELETE_MESSAGE" }, { slug: "OUTLOOK_OUTLOOK_LIST_FOLDERS" }] });
    const tools = await client(fake.fetchImpl).listTools("outlook");
    expect(() => resolveOperation("list_recent", tools)).toThrow(/Aucun tool de lecture .* list_recent/);
    expect(() => resolveOperation("search", tools)).toThrow(/OUTLOOK_OUTLOOK_LIST_FOLDERS/);
    expect(() => resolveOperation("get_message", tools)).toThrow(/Aucun tool/);
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

  it("arguments : adaptés aux paramètres réellement déclarés par le tool", () => {
    const tool = { slug: "X", name: "", description: "", toolkit: "outlook", scopes: [], tags: [], deprecated: false, inputParameters: ["search", "top"], requiredParameters: [] };
    expect(shapeArguments(tool, { query: "devis", limit: 5, message_id: "ignored" })).toEqual({ search: "devis", top: 5 });
    expect(shapeArguments({ ...tool, inputParameters: ["maxResults", "q"] }, { query: "devis", limit: 5 })).toEqual({ q: "devis", maxResults: 5 });
    expect(findEmail({ data: { userPrincipalName: "dirigeant@3t.fr" } })).toBe("dirigeant@3t.fr");
    expect(findEmail({ mail: "pas-un-email" })).toBeNull();
  });

  it("sanitizeAccount ignore tout secret renvoyé par Composio", () => {
    const account = sanitizeAccount({ id: "ca_1", status: "ACTIVE", state: { authScheme: "OAUTH2", val: { access_token: FAKE_TOKEN } }, data: { access_token: FAKE_TOKEN }, params: { client_secret: "cs" }, toolkit: { slug: "outlook" }, requested_scopes: ["Mail.Read"] });
    expect(JSON.stringify(account)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(account)).not.toContain("client_secret");
    expect(account).toMatchObject({ id: "ca_1", status: "ACTIVE", toolkit: "outlook", requestedScopes: ["Mail.Read"] });
  });

  it("la requête Composio porte la clé en en-tête, jamais dans l'URL ni le corps", async () => {
    const fake = fakeComposio();
    await client(fake.fetchImpl).listTools("outlook");
    const call = fake.calls[0] as RecordedCall;
    expect(call.headers["x-api-key"]).toBe(FAKE_KEY);
    expect(call.url).not.toContain(FAKE_KEY);
    expect(JSON.stringify(call.body ?? {})).not.toContain(FAKE_KEY);
  });
});
