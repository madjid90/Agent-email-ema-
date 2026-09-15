import { describe, it, expect, beforeEach } from "vitest";
import { openIsolatedDb, type Db } from "@/database/connection";
import { buildAuthorizeUrl, completeConnection, consumeOAuthState, createOAuthState, disconnect, exchangeCodeForTokens, GRAPH_SCOPES } from "@/integrations/microsoft/oauth";
import { loadTokenSet, saveTokenSet } from "@/integrations/microsoft/token-store";
import { createConnectedGraphClient } from "@/integrations/microsoft/graph-client";
import { getToken } from "@/database/repositories/tokens";
import { fakeFetch, json, noSleep } from "./helpers/fake-graph";

describe("OAuth Microsoft", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
  });

  it("construit une URL d'autorisation avec les seules permissions nécessaires", () => {
    const url = new URL(buildAuthorizeUrl("abc"));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toBe("offline_access User.Read Mail.Read Mail.Send");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(GRAPH_SCOPES).not.toContain("Mail.ReadWrite");
  });

  it("refuse un état inconnu, expiré ou réutilisé", () => {
    expect(consumeOAuthState("nope", { db })).toBe(false);
    const s = createOAuthState({ db });
    expect(consumeOAuthState(s, { db })).toBe(true);
    expect(consumeOAuthState(s, { db })).toBe(false);
    const old = createOAuthState({ db, now: () => Date.now() - 11 * 60 * 1000 });
    expect(consumeOAuthState(old, { db })).toBe(false);
  });

  it("callback invalide : aucun token stocké", async () => {
    await expect(completeConnection({ code: "c", state: "bad" }, async () => ({ email: null, displayName: null }), { db })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getToken("microsoft", db)).toBeUndefined();
  });

  it("échange le code, stocke les tokens chiffrés avec l'adresse", async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: /POST .*\/oauth2\/v2\.0\/token/, handle: () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "Mail.Read" }) }]);
    const state = createOAuthState({ db });
    const r = await completeConnection({ code: "code-1", state }, async (at) => { expect(at).toBe("AT"); return { email: "moi@entreprise.fr", displayName: "Moi" }; }, { db, fetchImpl });
    expect(r.accountEmail).toBe("moi@entreprise.fr");
    expect((calls[0]?.body as Record<string, string>).grant_type).toBe("authorization_code");
    const row = getToken("microsoft", db);
    expect(row?.account_email).toBe("moi@entreprise.fr");
    expect(row?.encrypted).not.toContain("AT");
    expect(row?.encrypted).not.toContain("RT");
    expect(loadTokenSet(db)?.set.refreshToken).toBe("RT");
  });

  it("refuse un échange sans refresh token ou refusé par Microsoft", async () => {
    const noRefresh = fakeFetch([{ match: /token/, handle: () => json({ access_token: "AT", expires_in: 10 }) }]);
    await expect(exchangeCodeForTokens("c", { db, fetchImpl: noRefresh.fetchImpl })).rejects.toThrow(/offline_access/);
    const denied = fakeFetch([{ match: /token/, handle: () => json({ error: "invalid_grant", error_description: "bad code" }, 400) }]);
    await expect(exchangeCodeForTokens("c", { db, fetchImpl: denied.fetchImpl })).rejects.toMatchObject({ code: "INTEGRATION" });
  });

  it("client connecté : rafraîchit un token expiré avant l'appel et conserve l'ancien refresh token", async () => {
    saveTokenSet({ accessToken: "OLD", refreshToken: "RT", expiresAt: new Date(Date.now() - 1000).toISOString(), scope: "" }, "moi@entreprise.fr", db);
    const { fetchImpl, calls } = fakeFetch([
      { match: /POST .*\/token/, handle: () => json({ access_token: "NEW", expires_in: 3600 }) },
      { match: /GET .*\/me$/, handle: (c) => (c.headers.authorization === "Bearer NEW" ? json({ id: "u" }) : json({}, 401)) },
    ]);
    const client = createConnectedGraphClient({ db, fetchImpl, sleep: noSleep });
    await client.get("/me");
    expect((calls[0]?.body as Record<string, string>).grant_type).toBe("refresh_token");
    const stored = loadTokenSet(db);
    expect(stored?.set.accessToken).toBe("NEW");
    expect(stored?.set.refreshToken).toBe("RT");
    expect(stored?.accountEmail).toBe("moi@entreprise.fr");
  });

  it("client connecté : 401 déclenche un refresh, puis échec propre si le refresh échoue", async () => {
    saveTokenSet({ accessToken: "OLD", refreshToken: "RT", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, null, db);
    const { fetchImpl } = fakeFetch([
      { match: /POST .*\/token/, handle: () => json({ error: "invalid_grant" }, 400) },
      { match: /GET .*\/me$/, handle: () => json({}, 401) },
    ]);
    const client = createConnectedGraphClient({ db, fetchImpl, sleep: noSleep });
    await expect(client.get("/me")).rejects.toMatchObject({ code: "INTEGRATION" });
  });

  it("sans connexion Outlook, le client refuse d'appeler Graph", async () => {
    const client = createConnectedGraphClient({ db, fetchImpl: fakeFetch([]).fetchImpl, sleep: noSleep });
    await expect(client.get("/me")).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("déconnexion : tokens supprimés, curseur effacé", () => {
    saveTokenSet({ accessToken: "A", refreshToken: "R", expiresAt: new Date().toISOString(), scope: "" }, "moi@entreprise.fr", db);
    disconnect({ db });
    expect(loadTokenSet(db)).toBeNull();
  });
});
