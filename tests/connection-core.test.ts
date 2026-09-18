import { describe, expect, it } from "vitest";
import {
  AgencyConnectionHub,
  assertAgentCapability,
  buildComposioSessionPolicy,
  buildExternalConnectionUserId,
  canAgentUse,
  requiresHumanApproval,
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
