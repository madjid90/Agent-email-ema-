import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openIsolatedDb, type Db } from "@/database/connection";
import * as emails from "@/database/repositories/emails";
import * as approvals from "@/database/repositories/approvals";
import * as history from "@/database/repositories/history";
import { settingsSchema, type Settings } from "@/lib/config";
import { proposeAction, approveAction, rejectAction, executeAction, approveAndExecute, expireApprovals, registerExecutor, clearExecutors, canTransition } from "@/actions/engine";
import { requiresApproval, resolveRiskLevel } from "@/actions/policy";

function settings(overrides: Partial<Settings["agent"]> = {}): Settings {
  const s = settingsSchema.parse({ company: { name: "X", userName: "U", email: "u@x.fr" } });
  return { ...s, agent: { ...s.agent, ...overrides } };
}

describe("Politique de risque", () => {
  it("ne descend jamais sous le risque par défaut", () => {
    expect(resolveRiskLevel("sign_document", "LOW")).toBe("CRITICAL");
    expect(resolveRiskLevel("reply_email", "HIGH")).toBe("HIGH");
    expect(resolveRiskLevel("prepare_reply")).toBe("LOW");
  });

  it("HIGH et CRITICAL exigent toujours une validation", () => {
    const s = settings({ autoReplyEnabled: true });
    expect(requiresApproval("payment_request", "HIGH", false, s)).toBe(true);
    expect(requiresApproval("sign_document", "CRITICAL", false, s)).toBe(true);
  });

  it("l'envoi d'une réponse dépend d'autoReplyEnabled", () => {
    expect(requiresApproval("reply_email", "MEDIUM", undefined, settings())).toBe(true);
    expect(requiresApproval("reply_email", "MEDIUM", undefined, settings({ autoReplyEnabled: true }))).toBe(false);
    expect(requiresApproval("reply_email", "MEDIUM", true, settings({ autoReplyEnabled: true }))).toBe(true);
    expect(requiresApproval("prepare_reply", "LOW", undefined, settings())).toBe(false);
  });
});

describe("Action Engine", () => {
  let db: Db;
  let emailId: string;

  beforeEach(() => {
    db = openIsolatedDb();
    clearExecutors();
    emailId = emails.insertEmail({ graphId: "g", threadId: "t", senderEmail: "client@ext.fr", senderName: "Client", subject: "Devis", receivedAt: "2026-09-15T10:00:00.000Z" }, db).id;
  });
  afterEach(() => clearExecutors());

  it("une action LOW est approuvée automatiquement, sans validation", () => {
    const a = proposeAction({ type: "prepare_reply", title: "Brouillon", payload: { email_id: emailId, body: "Bonjour" }, sourceEmailId: emailId }, { db, settings: settings() });
    expect(a.status).toBe("APPROVED");
    expect(a.requires_approval).toBe(0);
    expect(approvals.listPendingApprovals(db)).toHaveLength(0);
  });

  it("une action CRITICAL passe en attente de validation avec une demande", () => {
    const a = proposeAction(
      { type: "sign_document", title: "Signer", payload: { email_id: emailId, document_id: "doc_x", company_id: "c", reply_body: "Ci-joint le devis signé." }, sourceEmailId: emailId },
      { db, settings: settings() },
    );
    expect(a.status).toBe("WAITING_APPROVAL");
    expect(a.risk_level).toBe("CRITICAL");
    const pending = approvals.listPendingApprovals(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.proposed_reply).toBe("Ci-joint le devis signé.");
    expect(history.listHistory({ actionId: a.id }, db).map((h) => h.event_type)).toContain("approval.requested");
  });

  it("refuse le payload invalide", () => {
    expect(() => proposeAction({ type: "forward_email", title: "x", payload: { email_id: emailId, to: ["pas-un-email"], comment: "" } }, { db, settings: settings() })).toThrow(/Payload invalide/);
  });

  it("interdit d'exécuter une action non validée", async () => {
    const a = proposeAction({ type: "reply_email", title: "Répondre", payload: { email_id: emailId, body: "Bonjour", reply_all: false, attachments: [] }, sourceEmailId: emailId }, { db, settings: settings() });
    await expect(executeAction(a.id, { db, settings: settings() })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("valide puis exécute une seule fois (idempotence)", async () => {
    let calls = 0;
    registerExecutor({ type: "reply_email", execute: async () => { calls++; return { ok: true, summary: "Envoyé" }; } });
    const a = proposeAction({ type: "reply_email", title: "Répondre", payload: { email_id: emailId, body: "Bonjour", reply_all: false, attachments: [] }, sourceEmailId: emailId }, { db, settings: settings() });
    const done = await approveAndExecute(a.id, "whatsapp", { db, settings: settings() });
    expect(done.status).toBe("COMPLETED");
    expect(calls).toBe(1);
    await expect(executeAction(a.id, { db, settings: settings() })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(() => approveAction(a.id, "user", { db, settings: settings() })).toThrow(/validation impossible/);
    expect(calls).toBe(1);
    expect(approvals.listPendingApprovals(db)).toHaveLength(0);
    const events = history.listHistory({ actionId: a.id }, db).map((h) => h.event_type);
    expect(events).toEqual(expect.arrayContaining(["action.proposed", "approval.requested", "approval.approved", "action.completed"]));
  });

  it("marque FAILED si l'exécuteur échoue, et permet le refus", async () => {
    registerExecutor({ type: "forward_email", execute: async () => { throw new Error("Graph indisponible"); } });
    const a = proposeAction({ type: "forward_email", title: "Transférer", payload: { email_id: emailId, to: ["magali@exemple.fr"], comment: "" }, sourceEmailId: emailId }, { db, settings: settings() });
    const r = await approveAndExecute(a.id, "user", { db, settings: settings() });
    expect(r.status).toBe("FAILED");
    expect(r.error).toContain("Graph indisponible");

    const b = proposeAction({ type: "forward_email", title: "Transférer", payload: { email_id: emailId, to: ["magali@exemple.fr"], comment: "" }, sourceEmailId: emailId }, { db, settings: settings() });
    const rejected = rejectAction(b.id, "whatsapp", "Pas maintenant", { db, settings: settings() });
    expect(rejected.status).toBe("REJECTED");
    expect(approvals.listPendingApprovals(db)).toHaveLength(0);
  });

  it("sans exécuteur enregistré, l'action passe en FAILED proprement", async () => {
    const a = proposeAction({ type: "payment_request", title: "Règlement", payload: { email_id: emailId, to: ["compta@x.fr"], subject: "Règlement", body: "Merci de payer", supplier: "F", amount: 100, currency: "EUR", due_date: null, project: null } }, { db, settings: settings() });
    const r = await approveAndExecute(a.id, "user", { db, settings: settings() });
    expect(r.status).toBe("FAILED");
    expect(r.error).toMatch(/Aucun exécuteur/);
  });

  it("expire les validations échues", () => {
    const a = proposeAction({ type: "reply_email", title: "Répondre", payload: { email_id: emailId, body: "Bonjour", reply_all: false, attachments: [] } }, { db, settings: settings() });
    db.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE action_id = ?").run(a.id);
    expect(expireApprovals({ db, settings: settings() })).toBe(1);
    expect(approvals.listPendingApprovals(db)).toHaveLength(0);
    // L'action reste en attente : jamais exécutée sans décision, renvoi ou refus possible
    expect(db.prepare("SELECT status FROM actions WHERE id = ?").get(a.id)).toEqual({ status: "WAITING_APPROVAL" });
    expect(expireApprovals({ db, settings: settings() })).toBe(0);
  });

  it("connaît les transitions autorisées", () => {
    expect(canTransition("WAITING_APPROVAL", "APPROVED")).toBe(true);
    expect(canTransition("COMPLETED", "APPROVED")).toBe(false);
    expect(canTransition("PROPOSED", "COMPLETED")).toBe(false);
  });
});
