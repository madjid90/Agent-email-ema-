import { describe, expect, it } from "vitest";
import {
  AgencyConnectionHub,
  assertAgentCapability,
  buildComposioSessionPolicy,
  buildExternalConnectionUserId,
  canAgentUse,
  requiresHumanApproval,
  resolveConnectionBackend,
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
