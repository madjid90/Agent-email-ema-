import { describe, expect, it } from "vitest";
import {
  AgencyConnectionHub,
  assertAgentCapability,
  buildComposioSessionPolicy,
  buildExternalConnectionUserId,
  canAgentUse,
  requiresHumanApproval,
  resolveConnectionBackend,
  createComposioSession,
} from "@/connections";

describe("Agency Connection Core", () => {
  it("génère un identifiant externe stable, opaque et isolé par organisation", () => {
    const a = buildExternalConnectionUserId("org-a", "user-1");
    const same = buildExternalConnectionUserId("org-a", "user-1");
    const otherOrg = buildExternalConnectionUserId("org-b", "user-1");

    expect(a).toBe(same);
    expect(a).not.toBe(otherOrg);
    expect(a).toMatch(/^ema_[a-f0-9]{64}$/);
    expect(a).not.toContain("org-a");
    expect(a).not.toContain("user-1");
  });

  it("EMA peut lire et préparer l'envoi mais pas écrire dans le CRM", () => {
    expect(canAgentUse("ema", "email.read")).toBe(true);
    expect(canAgentUse("ema", "email.send")).toBe(true);
    expect(requiresHumanApproval("ema", "email.send")).toBe(true);
    expect(canAgentUse("ema", "crm.write")).toBe(false);
    expect(() => assertAgentCapability("ema", "crm.write")).toThrow(/interdite/);
  });

  it("Knowledge est strictement read-only côté Composio", () => {
    const policy = buildComposioSessionPolicy("knowledge");
    expect(policy.tags.enable).toEqual(["readOnlyHint"]);
    expect(policy.tags.disable).toContain("destructiveHint");
    expect(policy.sandboxEnabled).toBe(false);
  });

  it("aucune politique standard n'autorise les tools destructifs", () => {
    for (const agent of ["ema", "archi", "sales", "knowledge", "custom"] as const) {
      expect(buildComposioSessionPolicy(agent).tags.disable).toContain("destructiveHint");
    }
  });

  it("un agent sur mesure démarre sans toolkit et sans droit", () => {
    const policy = buildComposioSessionPolicy("custom");
    expect(policy.toolkits).toEqual([]);
    expect(canAgentUse("custom", "email.read")).toBe(false);
  });

  it("reste en backend natif tant que Composio n'est pas explicitement activé", () => {
    const nativeEnv = {
      NODE_ENV: "test",
      ANTHROPIC_MODEL: "claude-opus-5",
      MICROSOFT_TENANT_ID: "common",
      WHATSAPP_API_VERSION: "v21.0",
      WHATSAPP_ASSISTANT_ENABLED: true,
      WHATSAPP_FOLLOWUP_TEMPLATE_LANG: "fr",
      APP_URL: "http://localhost:3000",
      ALLOW_SIGNUP: false,
      COMPOSIO_ENABLED: false,
      DATABASE_PATH: "./data/ema.db",
      PRIVATE_STORAGE_PATH: "./private",
      CONFIG_PATH: "./config",
      WORKER_POLL_INTERVAL: 120,
      EMAIL_SYNC_LIMIT: 50,
      EMAIL_INITIAL_SYNC_DAYS: 7,
      ATTACHMENT_MAX_MB: 15,
      OUTGOING_ATTACHMENT_MAX_MB: 3,
      PDF_EXTRACTION_TIMEOUT_SECONDS: 20,
      TRUST_PROXY_HEADER: false,
      LOG_LEVEL: "info",
    } as const;

    expect(resolveConnectionBackend(nativeEnv)).toBe("native");
    expect(resolveConnectionBackend({ ...nativeEnv, COMPOSIO_ENABLED: true, COMPOSIO_API_KEY: "cmp_test" })).toBe("composio");
  });

  it("crée une session Composio avec une politique restreinte et sans workbench", async () => {
    let capturedBody: unknown = null;
    let capturedHeaders: HeadersInit | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ session_id: "trs_test", mcp: { type: "http", url: "https://example.test/mcp" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await createComposioSession({
      apiKey: "cmp_secret",
      externalUserId: "ema_abc",
      policy: buildComposioSessionPolicy("knowledge"),
      fetchImpl,
    });

    expect(result.session_id).toBe("trs_test");
    expect(capturedBody).toEqual({
      user_id: "ema_abc",
      toolkits: { enabled: ["outlook", "one_drive", "share_point", "googledrive", "hubspot"] },
      tags: { enabled: ["readOnlyHint"], disabled: ["destructiveHint"] },
      workbench: { enable: false },
    });
    expect(capturedHeaders).toMatchObject({ "x-api-key": "cmp_secret" });
  });

  it("assainit les erreurs Composio et ne renvoie jamais la clé API", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "secret detail", slug: "INVALID_API_KEY", request_id: "req_1" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    await expect(
      createComposioSession({
        apiKey: "cmp_super_secret",
        externalUserId: "ema_abc",
        policy: buildComposioSessionPolicy("ema"),
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "INTEGRATION",
      message: "Composio a refusé la création de session",
      details: { status: 401, code: "INVALID_API_KEY", requestId: "req_1" },
    });
  });

  it("crée une session provider-neutral pour un utilisateur donné", async () => {
    const hub = new AgencyConnectionHub();
    const session = await hub.createSession({
      organizationId: "org-dupont",
      userId: "usr-jean",
      agentId: "archi",
    });

    expect(session.provider).toBe("composio");
    expect(session.externalUserId).toMatch(/^ema_/);
    expect(session.policy.toolkits).toContain("outlook");
    expect(session.policy.toolkits).toContain("share_point");
  });
});
