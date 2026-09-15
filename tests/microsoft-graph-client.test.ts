import { describe, it, expect } from "vitest";
import { GraphClient, GraphError } from "@/integrations/microsoft/graph-client";
import { fakeFetch, json, noSleep } from "./helpers/fake-graph";

describe("GraphClient", () => {
  it("ajoute le bearer et parse la réponse", async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: /GET .*\/me$/, handle: () => json({ id: "u1", mail: "moi@entreprise.fr" }) }]);
    const client = new GraphClient({ getAccessToken: async () => "tok", fetchImpl, sleep: noSleep });
    const me = await client.get<{ mail: string }>("/me");
    expect(me.mail).toBe("moi@entreprise.fr");
    expect(calls[0]?.headers.authorization).toBe("Bearer tok");
  });

  it("rafraîchit le token sur 401 et rejoue une seule fois", async () => {
    let refreshed = 0;
    const { fetchImpl, calls } = fakeFetch([
      { match: /GET .*\/me$/, handle: (call) => (call.headers.authorization === "Bearer fresh" ? json({ id: "u1" }) : json({ error: { code: "InvalidAuthenticationToken", message: "expired" } }, 401)) },
    ]);
    const client = new GraphClient({ getAccessToken: async () => "stale", onUnauthorized: async () => { refreshed++; return "fresh"; }, fetchImpl, sleep: noSleep });
    await client.get("/me");
    expect(refreshed).toBe(1);
    expect(calls).toHaveLength(2);

    const stillBad = new GraphClient({ getAccessToken: async () => "stale", onUnauthorized: async () => "stale", fetchImpl, sleep: noSleep });
    await expect(stillBad.get("/me")).rejects.toBeInstanceOf(GraphError);
  });

  it("respecte Retry-After sur 429 puis réussit", async () => {
    const waits: number[] = [];
    const { fetchImpl } = fakeFetch([{ match: /GET .*\/me\/messages/, handle: (_c, n) => (n < 3 ? json({ error: { code: "TooManyRequests" } }, 429, { "retry-after": "2" }) : json({ value: [] })) }]);
    const client = new GraphClient({ getAccessToken: async () => "tok", fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    const page = await client.get<{ value: unknown[] }>("/me/messages");
    expect(page.value).toEqual([]);
    expect(waits).toEqual([2000, 2000]);
  });

  it("réessaie sur 500 puis échoue avec une erreur assainie", async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: /GET .*\/me$/, handle: () => json({ error: { code: "InternalServerError", message: "boom secret=123" } }, 500) }]);
    const client = new GraphClient({ getAccessToken: async () => "tok", fetchImpl, sleep: noSleep, maxRetries: 2 });
    const err = await client.get("/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).httpStatus).toBe(500);
    expect((err as GraphError).graphCode).toBe("InternalServerError");
    expect((err as GraphError).code).toBe("INTEGRATION");
    expect(calls).toHaveLength(3);
  });

  it("suit la pagination nextLink jusqu'à la limite", async () => {
    const { fetchImpl } = fakeFetch([
      { match: /GET .*\/me\/messages\?\$top=2$/, handle: () => json({ value: [{ id: "1" }, { id: "2" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skip=2" }) },
      { match: /GET .*\$skip=2/, handle: () => json({ value: [{ id: "3" }, { id: "4" }] }) },
    ]);
    const client = new GraphClient({ getAccessToken: async () => "tok", fetchImpl, sleep: noSleep });
    expect((await client.getAll<{ id: string }>("/me/messages", { $top: 2 })).map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
    expect((await client.getAll<{ id: string }>("/me/messages", { $top: 2 }, { limit: 3 })).map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("convertit une panne réseau en erreur INTEGRATION", async () => {
    const failing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const client = new GraphClient({ getAccessToken: async () => "tok", fetchImpl: failing, sleep: noSleep, maxRetries: 1 });
    await expect(client.get("/me")).rejects.toMatchObject({ code: "INTEGRATION" });
  });
});
