import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { openIsolatedDb, type Db } from "@/database/connection";
import * as emails from "@/database/repositories/emails";
import * as analyses from "@/database/repositories/analyses";
import * as actions from "@/database/repositories/actions";
import * as approvals from "@/database/repositories/approvals";
import { listHistory } from "@/database/repositories/history";
import { WhatsappClient, WhatsappError } from "@/integrations/whatsapp/client";
import { parseWebhook, parseButtonId, verifySignature, verifySubscription } from "@/integrations/whatsapp/webhook";
import { buildApprovalMessages, formatApprovalBody } from "@/integrations/whatsapp/messages";
import { notifyPendingApproval, notifyUnsentApprovals, handleInboundEvent, MAX_NOTIFY_ATTEMPTS } from "@/integrations/whatsapp/approvals";
import { proposeAction, approveAndExecute, editActionPayload, expireApprovals, createApprovalRequest, retryAction, clearExecutors, registerExecutor } from "@/actions/engine";
import { createOutlookExecutors } from "@/actions/executors/outlook";
import { GraphClient } from "@/integrations/microsoft/graph-client";
import { saveTokenSet } from "@/integrations/microsoft/token-store";
import { settingsSchema } from "@/lib/config";
import { fakeWhatsapp, buttonWebhook } from "./helpers/fake-whatsapp";
import { fakeFetch, json, message, noSleep } from "./helpers/fake-graph";
import { analysisFixture } from "./helpers/fake-anthropic";

const APPROVER = "33612345678";
const settings = settingsSchema.parse({ company: { name: "X", userName: "U", email: "u@x.fr" } });

function graphOk() {
  const { fetchImpl, calls } = fakeFetch([
    { match: /POST .*\/messages\/g1\/reply$/, handle: () => new Response(null, { status: 202 }) },
    { match: /GET .*\/sentitems\/messages\?/, handle: () => json({ value: [message({ id: "sent-1", conversationId: "conv", from: { emailAddress: { address: "moi@entreprise.fr" } }, sentDateTime: new Date().toISOString() })] }) },
  ]);
  return { client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep }), calls };
}

function graphFailing() {
  const { fetchImpl, calls } = fakeFetch([{ match: /POST .*\/reply$/, handle: () => json({ error: { code: "ErrorSendAsDenied" } }, 403) }]);
  return { client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep, maxRetries: 0 }), calls };
}

function seed(db: Db) {
  saveTokenSet({ accessToken: "t", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, "moi@entreprise.fr", db);
  const email = emails.insertEmail({ graphId: "g1", threadId: "conv", senderName: "Jean Dupont", senderEmail: "jean@abc.fr", subject: "Paiement facture septembre", bodyText: "Quand sera effectué le règlement ?", receivedAt: "2026-09-15T10:00:00.000Z", status: "ANALYZED" }, db);
  analyses.insertAnalysis(email.id, analysisFixture({ category: "PAYMENT_REQUEST", summary: "Le fournisseur demande quand le règlement sera effectué.", company_name: "ABC", confidence: 0.94, reply_draft: "Bonjour Jean,\nLe règlement est en cours de traitement.\nCordialement" }), { model: "claude-opus-5" }, db);
  const action = proposeAction({ type: "reply_email", title: "Répondre à Jean Dupont — Paiement facture septembre", payload: { email_id: email.id, body: "Bonjour Jean,\nLe règlement est en cours de traitement.\nCordialement" }, sourceEmailId: email.id, requiresApproval: true }, { db, settings });
  return { email, action };
}

describe("Client WhatsApp", () => {
  it("envoie un message et renvoie l'identifiant", async () => {
    const wa = fakeWhatsapp();
    const r = await wa.client.send({ messaging_product: "whatsapp", to: APPROVER, type: "text", text: { body: "hello" } });
    expect(r.messageId).toBe("wamid.1");
    expect(wa.calls[0]?.headers.authorization).toBe("Bearer TOKEN");
  });

  it("400 / 401 : erreur non réessayée ; 429 puis succès ; 500 épuisé", async () => {
    const bad = fakeWhatsapp({ fail: () => json({ error: { message: "bad", code: 100 } }, 400) });
    await expect(bad.client.send({ messaging_product: "whatsapp", to: APPROVER, type: "text", text: { body: "x" } })).rejects.toMatchObject({ httpStatus: 400, retryable: false });
    expect(bad.calls).toHaveLength(1);
    const auth = fakeWhatsapp({ fail: () => json({ error: { message: "expired", code: 190 } }, 401) });
    const e = await auth.client.send({ messaging_product: "whatsapp", to: APPROVER, type: "text", text: { body: "x" } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WhatsappError);
    expect((e as WhatsappError).message).toContain("Token WhatsApp invalide");
    const rate = fakeWhatsapp({ fail: (n) => (n === 1 ? json({ error: { code: 4 } }, 429) : null) });
    expect((await rate.client.send({ messaging_product: "whatsapp", to: APPROVER, type: "text", text: { body: "x" } })).messageId).toBe("wamid.2");
    const down = fakeWhatsapp({ fail: () => json({ error: { message: "oops" } }, 500) });
    await expect(down.client.send({ messaging_product: "whatsapp", to: APPROVER, type: "text", text: { body: "x" } })).rejects.toMatchObject({ httpStatus: 500, retryable: true });
    expect(down.calls).toHaveLength(3);
  });

  it("panne réseau → INTEGRATION", async () => {
    const failing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const client = new WhatsappClient({ accessToken: "T", phoneNumberId: "P", fetchImpl: failing, sleep: async () => {}, maxRetries: 0 });
    await expect(client.send({ messaging_product: "whatsapp", to: APPROVER, type: "text", text: { body: "x" } })).rejects.toMatchObject({ code: "INTEGRATION" });
  });
});

describe("Webhook WhatsApp", () => {
  it("vérifie l'abonnement Meta", () => {
    expect(verifySubscription(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "secret", "hub.challenge": "123" }), "secret")).toBe("123");
    expect(verifySubscription(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "123" }), "secret")).toBeNull();
    expect(verifySubscription(new URLSearchParams({ "hub.mode": "unsubscribe", "hub.verify_token": "secret" }), "secret")).toBeNull();
    expect(verifySubscription(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "secret" }), undefined)).toBeNull();
  });

  it("vérifie la signature X-Hub-Signature-256", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    expect(verifySignature(body, sig, "app-secret")).toBe(true);
    expect(verifySignature(body, sig, "other")).toBe(false);
    expect(verifySignature(body, null, "app-secret")).toBe(false);
    expect(verifySignature(body, "sha1=abc", "app-secret")).toBe(false);
  });

  it("parse les boutons, ignore les statuts et les corps malformés", () => {
    const events = parseWebhook(buttonWebhook(APPROVER, "approve:apr_0123456789ab", "wamid.x"));
    expect(events).toEqual([{ kind: "button_reply", messageId: "wamid.x", from: APPROVER, timestamp: "1700000000", buttonId: "approve:apr_0123456789ab", buttonTitle: "✅ Valider", text: null }]);
    expect(parseWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: "x", status: "delivered" }] } }] }] })).toEqual([]);
    expect(parseWebhook("garbage")).toEqual([]);
    expect(parseWebhook({ entry: [{ changes: [{ value: { messages: [{ id: 1 }] } }] }] })).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
    expect(parseButtonId("approve:apr_0123456789ab")).toEqual({ decision: "approve", approvalId: "apr_0123456789ab" });
    expect(parseButtonId("reject:apr_0123456789ab")?.decision).toBe("reject");
    expect(parseButtonId("approve:../etc")).toBeNull();
    expect(parseButtonId(null)).toBeNull();
  });
});

describe("Message de validation", () => {
  it("est lisible et compact, avec boutons Valider / Refuser", () => {
    const input = { approvalId: "apr_0123456789ab", kind: "reply_email", senderName: "Jean Dupont", senderEmail: "jean@abc.fr", company: "ABC", subject: "Paiement facture septembre", summary: "Le fournisseur demande quand le règlement sera effectué.", proposedAction: "Répondre à l'email dans le thread", proposedReply: "Bonjour Jean,\n...", confidence: 0.94, humanReviewNote: null };
    const body = formatApprovalBody(input);
    expect(body).toContain("📩 EMA — Réponse à valider");
    expect(body).toContain("De : Jean Dupont <jean@abc.fr>");
    expect(body).toContain("Entreprise : ABC");
    expect(body).toContain("Confiance : 94 %");
    const msgs = buildApprovalMessages(APPROVER, input);
    expect(msgs).toHaveLength(1);
    const m = msgs[0]!;
    expect(m.type).toBe("interactive");
    if (m.type === "interactive") expect(m.interactive.action.buttons.map((b) => b.reply.id)).toEqual(["approve:apr_0123456789ab", "reject:apr_0123456789ab"]);
    const long = buildApprovalMessages(APPROVER, { ...input, proposedReply: "x".repeat(2000) });
    expect(long.map((x) => x.type)).toEqual(["text", "interactive"]);
    if (long[1]?.type === "interactive") expect(long[1].interactive.body.text.length).toBeLessThanOrEqual(1024);
  });
});

describe("Validation WhatsApp de bout en bout", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    clearExecutors();
  });
  afterEach(() => clearExecutors());

  it("envoi de la demande : une seule notification, identifiant conservé, historique", async () => {
    const { action } = seed(db);
    const wa = fakeWhatsapp();
    const r1 = await notifyPendingApproval(action.id, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(r1.sent).toBe(true);
    expect(wa.sent()).toHaveLength(1);
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    expect(apr.external_message_id).toBe("wamid.1");
    expect(apr.sent_at).not.toBeNull();
    const r2 = await notifyPendingApproval(action.id, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(r2.sent).toBe(false);
    expect(r2.reason).toContain("déjà envoyée");
    expect(wa.sent()).toHaveLength(1);
    expect(await notifyUnsentApprovals({ db, client: wa.client, approverPhone: APPROVER, settings })).toBe(0);
    expect(listHistory({ actionId: action.id }, db).map((h) => h.event_type)).toContain("approval.sent");
  });

  it("WhatsApp indisponible : échec enregistré, relancé par le worker, borné en tentatives", async () => {
    const { action } = seed(db);
    const down = fakeWhatsapp({ fail: () => json({ error: { message: "oops" } }, 500) });
    const r = await notifyPendingApproval(action.id, { db, client: down.client, approverPhone: APPROVER, settings });
    expect(r.sent).toBe(false);
    expect(approvals.getPendingApprovalForAction(action.id, db)?.last_notify_error).toContain("Erreur serveur WhatsApp");
    expect(listHistory({ actionId: action.id }, db).some((h) => h.event_type === "approval.send_failed")).toBe(true);
    const ok = fakeWhatsapp();
    expect(await notifyUnsentApprovals({ db, client: ok.client, approverPhone: APPROVER, settings })).toBe(1);
    // tentatives épuisées
    const { action: other } = seed(openIsolatedDb());
    void other;
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    db.prepare("UPDATE approvals SET external_message_id = NULL, notify_attempts = ? WHERE id = ?").run(MAX_NOTIFY_ATTEMPTS, apr.id);
    expect((await notifyPendingApproval(action.id, { db, client: ok.client, approverPhone: APPROVER, settings })).reason).toContain("tentatives");
  });

  it("VALIDER : approval APPROVED, action exécutée via Graph dans le thread, COMPLETED, confirmation, historique", async () => {
    const { action, email } = seed(db);
    const g = graphOk();
    for (const ex of createOutlookExecutors({ db, client: g.client, settings })) registerExecutor(ex);
    const wa = fakeWhatsapp();
    await notifyPendingApproval(action.id, { db, client: wa.client, approverPhone: APPROVER, settings });
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    const [event] = parseWebhook(buttonWebhook(APPROVER, `approve:${apr.id}`));
    const r = await handleInboundEvent(event!, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(r.outcome).toBe("approved");
    expect(actions.getAction(action.id, db)?.status).toBe("COMPLETED");
    expect(approvals.getApproval(apr.id, db)?.status).toBe("APPROVED");
    expect(approvals.getApproval(apr.id, db)?.decided_by).toContain("whatsapp:");
    const reply = g.calls.find((c) => c.url.endsWith("/messages/g1/reply"));
    expect((reply?.body as { comment: string }).comment).toContain("Le règlement est en cours");
    expect(emails.getEmailByGraphId("sent-1", db)?.direction).toBe("outbound");
    expect(emails.getEmail(email.id, db)?.status).toBe("PROCESSED");
    const last = wa.sent().at(-1);
    expect(last?.type === "text" && last.text.body.startsWith("✅")).toBe(true);
    const events = listHistory({ actionId: action.id }, db).map((h) => h.event_type);
    expect(events).toEqual(expect.arrayContaining(["action.proposed", "approval.requested", "approval.sent", "approval.approved", "action.completed"]));
  });

  it("REFUSER : approval et action REJECTED, aucun appel Graph", async () => {
    const { action } = seed(db);
    const g = graphOk();
    for (const ex of createOutlookExecutors({ db, client: g.client, settings })) registerExecutor(ex);
    const wa = fakeWhatsapp();
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    const [event] = parseWebhook(buttonWebhook(APPROVER, `reject:${apr.id}`));
    const r = await handleInboundEvent(event!, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(r.outcome).toBe("rejected");
    expect(actions.getAction(action.id, db)?.status).toBe("REJECTED");
    expect(approvals.getApproval(apr.id, db)?.status).toBe("REJECTED");
    expect(g.calls).toHaveLength(0);
    expect(listHistory({ actionId: action.id }, db).some((h) => h.event_type === "approval.rejected")).toBe(true);
  });

  it("mauvais numéro : ignoré, aucune trace de décision", async () => {
    const { action } = seed(db);
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    const [event] = parseWebhook(buttonWebhook("33699999999", `approve:${apr.id}`));
    const r = await handleInboundEvent(event!, { db, client: fakeWhatsapp().client, approverPhone: APPROVER, settings });
    expect(r.outcome).toBe("unauthorized");
    expect(actions.getAction(action.id, db)?.status).toBe("WAITING_APPROVAL");
    expect(approvals.getApproval(apr.id, db)?.status).toBe("PENDING");
    const none = await handleInboundEvent(event!, { db, client: fakeWhatsapp().client, approverPhone: null, settings });
    expect(none.outcome).toBe("unauthorized");
  });

  it("approval inexistante ou expirée : rien n'est exécuté", async () => {
    const { action } = seed(db);
    const g = graphOk();
    for (const ex of createOutlookExecutors({ db, client: g.client, settings })) registerExecutor(ex);
    const wa = fakeWhatsapp();
    const unknown = await handleInboundEvent(parseWebhook(buttonWebhook(APPROVER, "approve:apr_000000000000"))[0]!, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(unknown.outcome).toBe("unknown");
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    db.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(apr.id);
    const expired = await handleInboundEvent(parseWebhook(buttonWebhook(APPROVER, `approve:${apr.id}`))[0]!, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(expired.outcome).toBe("expired");
    expect(approvals.getApproval(apr.id, db)?.status).toBe("EXPIRED");
    expect(actions.getAction(action.id, db)?.status).toBe("WAITING_APPROVAL");
    expect(g.calls).toHaveLength(0);
  });

  it("expiration par le worker : approval EXPIRED, action toujours en attente, renvoi possible", async () => {
    const { action } = seed(db);
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    db.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(apr.id);
    expect(expireApprovals({ db, settings })).toBe(1);
    expect(actions.getAction(action.id, db)?.status).toBe("WAITING_APPROVAL");
    expect(approvals.getPendingApprovalForAction(action.id, db)).toBeUndefined();
    const again = createApprovalRequest(action.id, { db, settings });
    expect(again.id).not.toBe(apr.id);
    expect(again.status).toBe("PENDING");
    expect(createApprovalRequest(action.id, { db, settings }).id).toBe(again.id); // pas de doublon
    const wa = fakeWhatsapp();
    expect((await notifyPendingApproval(action.id, { db, client: wa.client, approverPhone: APPROVER, settings })).sent).toBe(true);
  });

  it("double clic et rejeu du webhook : une seule exécution", async () => {
    const { action } = seed(db);
    const g = graphOk();
    for (const ex of createOutlookExecutors({ db, client: g.client, settings })) registerExecutor(ex);
    const wa = fakeWhatsapp();
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    const first = buttonWebhook(APPROVER, `approve:${apr.id}`, "wamid.same");
    const r1 = await handleInboundEvent(parseWebhook(first)[0]!, { db, client: wa.client, approverPhone: APPROVER, settings });
    const replay = await handleInboundEvent(parseWebhook(first)[0]!, { db, client: wa.client, approverPhone: APPROVER, settings });
    const secondClick = await handleInboundEvent(parseWebhook(buttonWebhook(APPROVER, `approve:${apr.id}`, "wamid.other"))[0]!, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(r1.outcome).toBe("approved");
    expect(replay.outcome).toBe("duplicate");
    expect(secondClick.outcome).toBe("already_decided");
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("validation simultanée interface + WhatsApp : une seule exécution", async () => {
    const { action } = seed(db);
    const g = graphOk();
    for (const ex of createOutlookExecutors({ db, client: g.client, settings })) registerExecutor(ex);
    const wa = fakeWhatsapp();
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    const results = await Promise.allSettled([
      approveAndExecute(action.id, "user", { db, settings }),
      handleInboundEvent(parseWebhook(buttonWebhook(APPROVER, `approve:${apr.id}`))[0]!, { db, client: wa.client, approverPhone: APPROVER, settings }),
    ]);
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(actions.getAction(action.id, db)?.status).toBe("COMPLETED");
    const outcomes = results.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { code: string }).code));
    expect(outcomes.filter((o) => o === "ok" || o === "CONFLICT" || o === "INVALID_TRANSITION").length).toBe(2);
  });

  it("Graph échoue après validation : action FAILED, jamais considérée envoyée, réessai possible", async () => {
    const { action, email } = seed(db);
    const bad = graphFailing();
    for (const ex of createOutlookExecutors({ db, client: bad.client, settings })) registerExecutor(ex);
    const wa = fakeWhatsapp();
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    const r = await handleInboundEvent(parseWebhook(buttonWebhook(APPROVER, `approve:${apr.id}`))[0]!, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(r.outcome).toBe("failed");
    expect(actions.getAction(action.id, db)?.status).toBe("FAILED");
    expect(emails.getEmail(email.id, db)?.status).not.toBe("PROCESSED");
    expect(wa.sent().at(-1)?.type === "text" && (wa.sent().at(-1) as { text: { body: string } }).text.body.startsWith("⚠")).toBe(true);
    clearExecutors();
    const good = graphOk();
    for (const ex of createOutlookExecutors({ db, client: good.client, settings })) registerExecutor(ex);
    const retried = await retryAction(action.id, "user", { db, settings });
    expect(retried.status).toBe("COMPLETED");
    await expect(retryAction(action.id, "user", { db, settings })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("brouillon modifié manuellement : payload définitif, approval mise à jour, historique, envoi du texte modifié", async () => {
    const { action } = seed(db);
    const g = graphOk();
    for (const ex of createOutlookExecutors({ db, client: g.client, settings })) registerExecutor(ex);
    const edited = editActionPayload(action.id, { body: "Bonjour Jean,\nLe règlement sera effectué vendredi.\nCordialement" }, "user", { db, settings });
    expect(JSON.parse(edited.payload).body).toContain("vendredi");
    expect(approvals.getPendingApprovalForAction(action.id, db)?.proposed_reply).toContain("vendredi");
    expect(listHistory({ actionId: action.id }, db).some((h) => h.event_type === "action.payload_edited")).toBe(true);
    expect(() => editActionPayload(action.id, { body: "" }, "user", { db, settings })).toThrow(/invalide/);
    await approveAndExecute(action.id, "user", { db, settings });
    const reply = g.calls.find((c) => c.url.endsWith("/reply"));
    expect((reply?.body as { comment: string }).comment).toContain("vendredi");
    expect(() => editActionPayload(action.id, { body: "trop tard" }, "user", { db, settings })).toThrow(/modification impossible/);
  });
});
