import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { openIsolatedDb, type Db } from "@/database/connection";
import * as emails from "@/database/repositories/emails";
import * as actions from "@/database/repositories/actions";
import * as approvals from "@/database/repositories/approvals";
import * as followupsRepo from "@/database/repositories/followups";
import { listHistory } from "@/database/repositories/history";
import { parseJson, type EmailRow } from "@/database/types";
import { resolveFollowupDate, dayBounds } from "@/followups/schedule";
import { classifyReply, checkThread } from "@/followups/detect";
import { scheduleFollowup, processFollowup, processDueFollowups, reconcileFollowups, postponeFollowup, notifyFollowup } from "@/followups/service";
import { rejectAction, clearExecutors, registerExecutor } from "@/actions/engine";
import { createOutlookExecutors } from "@/actions/executors/outlook";
import { GraphClient } from "@/integrations/microsoft/graph-client";
import { saveTokenSet } from "@/integrations/microsoft/token-store";
import { handleWhatsappEvent } from "@/integrations/whatsapp/router";
import { buildApprovalMessageInput } from "@/integrations/whatsapp/approvals";
import { formatApprovalBody } from "@/integrations/whatsapp/messages";
import { parseWebhook, parseReminderButtonId } from "@/integrations/whatsapp/webhook";
import { registerAllTools, resetToolsForTests, executeTool } from "@/tools";
import { setFollowupGraphClientForTests } from "@/followups/service";
import { WHATSAPP_TOOLS } from "@/agent/whatsapp-assistant";
import { lastRefs } from "@/agent/references";
import { settingsSchema, writeConfig, type Contact } from "@/lib/config";
import { privateRoot } from "@/lib/paths";
import Anthropic from "@anthropic-ai/sdk";
import { setAnthropicClientForTests } from "@/integrations/anthropic/client";
import { resetEnvCache } from "@/lib/env";
import { fakeAnthropic, timeoutError } from "./helpers/fake-anthropic";
import { fakeWhatsapp, textWebhook, buttonWebhook } from "./helpers/fake-whatsapp";
import { fakeFetch, json, message, noSleep } from "./helpers/fake-graph";
import { turn, systemTextOf } from "./helpers/fake-chat";

const APPROVER = "33612345678";
const settings = settingsSchema.parse({
  company: { name: "GOMU", userName: "Madjid", email: "moi@gomu.fr", timezone: "Europe/Paris" },
  agent: { signatureText: "Cordialement,\nMadjid" },
  followups: { enabled: true, defaultDelayDays: 3, defaultTime: "09:00", maxAttempts: 2, businessDaysOnly: false, requireApproval: true, autoReplyPostponeDays: 1 },
});
const contacts: Contact[] = [{ id: "nabila", name: "Nabila", email: "nabila@gomu.fr", role: "Comptabilité", internal: true }];

const DRAFT = {
  followup_needed: true,
  summary: "Relance sur l'intervention caisse",
  recipient: "Kevin Martin",
  subject: "RE: Intervention caisse",
  body: "Bonjour Kevin,\n\nJe me permets de revenir vers vous concernant ma demande d'intervention.\n\nAvez-vous pu en prendre connaissance ?\n\nCordialement,\nMadjid",
  confidence: 0.9,
  requires_human_review: false,
  reason: "Aucune réponse depuis 3 jours",
};

/** Thread Outlook simulé : les messages renvoyés par Graph à la vérification. */
function graphThread(messages: ReturnType<typeof message>[]) {
  const { fetchImpl, calls } = fakeFetch([
    { match: /GET .*\/me\/messages\?.*conversationId/, handle: () => json({ value: messages }) },
    { match: /POST .*\/messages\/[^/]+\/reply$/, handle: () => new Response(null, { status: 202 }) },
    { match: /GET .*\/sentitems\/messages\?/, handle: () => json({ value: [] }) },
  ]);
  return { client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep }), calls };
}
function graphDown() {
  const { fetchImpl, calls } = fakeFetch([{ match: /GET .*\/me\/messages\?/, handle: () => json({ error: { code: "ServiceUnavailable" } }, 503) }]);
  return { client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep, maxRetries: 0 }), calls };
}

/** Idempotent : le même message sortant est réutilisé (comme Outlook le renverrait). */
function seedThread(db: Db): { outbound: EmailRow } {
  saveTokenSet({ accessToken: "t", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, "moi@gomu.fr", db);
  const known = emails.getEmailByGraphId("g-out", db);
  if (known) return { outbound: known };
  const outbound = emails.insertEmail(
    { graphId: "g-out", threadId: "conv-1", direction: "outbound", senderName: "Madjid", senderEmail: "moi@gomu.fr", toRecipients: ["kevin@abc.fr"], subject: "Intervention caisse", bodyText: "Bonjour Kevin, pouvez-vous intervenir mardi ?", receivedAt: "2026-09-12T09:00:00.000Z", status: "PROCESSED" },
    db,
  );
  return { outbound };
}

function makeFollowup(db: Db, over: Partial<Parameters<typeof scheduleFollowup>[0]> = {}) {
  return scheduleFollowup({ reason: "Retour attendu sur l'intervention", ...over }, { db, settings, now: () => new Date("2026-09-12T10:00:00.000Z") });
}

/** Rend la relance échue (sans attendre 3 jours). */
function makeDue(db: Db, id: string, at = "2026-09-15T08:00:00.000Z") {
  followupsRepo.updateFollowup(id, {}, db);
  db.prepare("UPDATE scheduled_followups SET execute_at = ? WHERE id = ?").run(at, id);
}

describe("Calcul des échéances (jamais par le modèle)", () => {
  const now = new Date("2026-09-15T14:30:00.000Z"); // mardi 16h30 à Paris

  it("délai par défaut, « dans 3 jours », heure par défaut et heure explicite", () => {
    expect(resolveFollowupDate(null, settings, now)).toBe("2026-09-18T07:00:00.000Z"); // 09:00 Paris
    expect(resolveFollowupDate({ in_days: 3 }, settings, now)).toBe("2026-09-18T07:00:00.000Z");
    expect(resolveFollowupDate({ in_days: 1, time: "18:30" }, settings, now)).toBe("2026-09-16T16:30:00.000Z");
    // Aujourd'hui à 09:00 est déjà passé → lendemain
    expect(resolveFollowupDate({ in_days: 0 }, settings, now)).toBe("2026-09-16T07:00:00.000Z");
  });

  it("date explicite et jour de la semaine", () => {
    expect(resolveFollowupDate({ date: "2026-09-22" }, settings, now)).toBe("2026-09-22T07:00:00.000Z");
    expect(resolveFollowupDate({ weekday: "friday" }, settings, now)).toBe("2026-09-18T07:00:00.000Z");
    // Le même jour de la semaine renvoie à la semaine suivante
    expect(resolveFollowupDate({ weekday: "tuesday" }, settings, now)).toBe("2026-09-22T07:00:00.000Z");
    expect(() => resolveFollowupDate({ date: "22/09/2026" }, settings, now)).toThrow(/Date invalide/);
    expect(() => resolveFollowupDate({ in_days: 1, time: "25:00" }, settings, now)).toThrow(/Heure invalide/);
  });

  it("jours ouvrés : samedi et dimanche décalés au lundi", () => {
    const business = settingsSchema.parse({ ...settings, followups: { ...settings.followups, businessDaysOnly: true } });
    // vendredi 18 + 1 jour = samedi → lundi 21
    expect(resolveFollowupDate({ in_days: 3, time: "09:00" }, business, new Date("2026-09-18T14:00:00.000Z"))).toBe("2026-09-21T07:00:00.000Z");
    expect(dayBounds("Europe/Paris", now).start).toBe("2026-09-14T22:00:00.000Z");
  });
});

describe("Détection de réponse", () => {
  it("distingue réponse humaine, automatique et ambiguë", () => {
    const base = { id: "x", thread_id: "c", direction: "inbound" as const, sender_email: "kevin@abc.fr", subject: "RE: devis", body_text: "Bonjour, c'est noté, je reviens vers vous demain.", body_preview: "" };
    expect(classifyReply(base as unknown as EmailRow)).toBe("HUMAN_REPLY");
    expect(classifyReply({ ...base, subject: "Absence du bureau" } as unknown as EmailRow)).toBe("AUTO_REPLY");
    expect(classifyReply({ ...base, body_text: "Je suis actuellement absent jusqu'au 20 septembre." } as unknown as EmailRow)).toBe("AUTO_REPLY");
    expect(classifyReply({ ...base, sender_email: "no-reply@abc.fr" } as unknown as EmailRow)).toBe("AUTO_REPLY");
    expect(classifyReply({ ...base, subject: "Undeliverable: devis" } as unknown as EmailRow)).toBe("AUTO_REPLY");
    const long = `Je suis actuellement absent du bureau. ${"Cependant votre demande m'intéresse et je souhaite en discuter. ".repeat(8)} Pouvez-vous me confirmer le budget ?`;
    expect(classifyReply({ ...base, body_text: long } as unknown as EmailRow)).toBe("AMBIGUOUS");
  });

  it("n'examine que les messages postérieurs à l'ancrage", () => {
    const followup = { watch_after: "2026-09-12T09:00:00.000Z", created_at: "2026-09-12T09:00:00.000Z", recipient: "kevin@abc.fr" } as never;
    const older = { id: "old", direction: "inbound", received_at: "2026-09-10T08:00:00.000Z", sender_email: "kevin@abc.fr", subject: "Ancien", body_text: "ok", body_preview: "" } as unknown as EmailRow;
    const newer = { id: "new", direction: "inbound", received_at: "2026-09-13T08:00:00.000Z", sender_email: "kevin@abc.fr", subject: "Nouveau", body_text: "ok", body_preview: "" } as unknown as EmailRow;
    const outbound = { id: "out", direction: "outbound", received_at: "2026-09-14T08:00:00.000Z", sender_email: "moi@gomu.fr", subject: "Relance manuelle", body_text: "", body_preview: "" } as unknown as EmailRow;
    expect(checkThread([older], followup).reply).toBeNull();
    expect(checkThread([older, newer], followup).reply?.id).toBe("new");
    expect(checkThread([older, newer, outbound], followup).newerOutbound?.id).toBe("out");
  });
});

describe("Cycle de vie d'une relance", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    resetToolsForTests();
    registerAllTools();
    clearExecutors();
    writeConfig("contacts", { version: 1, contacts });
    writeConfig("settings", settings);
  });
  afterEach(() => {
    resetToolsForTests();
    clearExecutors();
    fs.rmSync(privateRoot(), { recursive: true, force: true });
  });

  it("programme une relance ancrée sur le dernier message envoyé", () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu", when: { in_days: 3 } });
    expect(f.status).toBe("SCHEDULED");
    expect(f.kind).toBe("EXTERNAL_FOLLOWUP");
    expect(f.thread_id).toBe("conv-1");
    expect(f.watch_after).toBe(outbound.received_at);
    expect(f.recipient).toBe("kevin@abc.fr"); // issu du thread, jamais inventé
    expect(f.max_attempts).toBe(2);
    expect(f.execute_at).toBe("2026-09-15T07:00:00.000Z");
    expect(listHistory({ emailId: outbound.id }, db).some((h) => h.event_type === "followup.created")).toBe(true);
  });

  it("réponse humaine reçue : relance annulée automatiquement, aucune action, aucun email", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([
      message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" }),
      message({ id: "g-reply", conversationId: "conv-1", subject: "RE: Intervention caisse", from: { emailAddress: { name: "Kevin", address: "kevin@abc.fr" } }, body: { contentType: "text", content: "Oui, mardi 10h me convient." }, receivedDateTime: "2026-09-14T08:00:00Z" }),
    ]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: fakeWhatsapp().client, approverPhone: APPROVER });
    expect(r.outcome).toBe("response_received");
    const after = followupsRepo.getFollowup(f.id, db)!;
    expect(after.status).toBe("RESPONSE_RECEIVED");
    expect(after.last_reply_email_id).not.toBeNull();
    expect(actions.listActions({}, db)).toHaveLength(0);
    expect(g.calls.some((c) => c.method === "POST")).toBe(false);
    expect(listHistory({}, db).some((h) => h.event_type === "followup.response_received")).toBe(true);
  });

  it("ancienne réponse antérieure à l'ancrage : ignorée, la relance est préparée", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([
      message({ id: "g-old", conversationId: "conv-1", subject: "RE: ancien", from: { emailAddress: { address: "kevin@abc.fr" } }, receivedDateTime: "2026-09-10T08:00:00Z" }),
      message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" }),
    ]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: fakeWhatsapp().client, approverPhone: APPROVER });
    expect(r.outcome).toBe("draft_created");
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("WAITING_APPROVAL");
  });

  it("réponse automatique : relance reportée, jamais annulée", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([
      message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" }),
      message({ id: "g-auto", conversationId: "conv-1", subject: "Absence du bureau", from: { emailAddress: { address: "kevin@abc.fr" } }, body: { contentType: "text", content: "Je suis actuellement absent jusqu'au 25." }, receivedDateTime: "2026-09-14T08:00:00Z" }),
    ]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client });
    expect(r.outcome).toBe("auto_reply_postponed");
    const after = followupsRepo.getFollowup(f.id, db)!;
    expect(after.status).toBe("SCHEDULED");
    expect(after.execute_at > "2026-09-15T08:00:00.000Z").toBe(true);
    expect(actions.listActions({}, db)).toHaveLength(0);
    expect(listHistory({}, db).some((h) => h.event_type === "followup.auto_reply_detected")).toBe(true);
  });

  it("réponse ambiguë : vérification humaine, aucune relance préparée, notification", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const long = `Je suis actuellement absent du bureau. ${"Votre demande m'intéresse et je souhaite en discuter à mon retour. ".repeat(8)} Pouvez-vous préciser le budget ?`;
    const g = graphThread([
      message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" }),
      message({ id: "g-amb", conversationId: "conv-1", subject: "RE: Intervention", from: { emailAddress: { address: "kevin@abc.fr" } }, body: { contentType: "text", content: long }, receivedDateTime: "2026-09-14T08:00:00Z" }),
    ]);
    const wa = fakeWhatsapp();
    const r = await processFollowup(f.id, { db, settings, graph: g.client, whatsapp: wa.client, approverPhone: APPROVER, client: fakeAnthropic([{ output: DRAFT }]).client });
    expect(r.outcome).toBe("review_required");
    expect(followupsRepo.getFollowup(f.id, db)?.requires_human_review).toBe(1);
    expect(actions.listActions({}, db)).toHaveLength(0);
    expect(JSON.stringify(wa.sent())).toContain("incertaine");
  });

  it("message sortant manuel plus récent : ancienne relance obsolète", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([
      message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" }),
      message({ id: "g-out2", conversationId: "conv-1", subject: "Suite", from: { emailAddress: { address: "moi@gomu.fr" } }, toRecipients: [{ emailAddress: { address: "kevin@abc.fr" } }], receivedDateTime: "2026-09-14T08:00:00Z" }),
    ]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client });
    expect(r.outcome).toBe("superseded");
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("SUPERSEDED");
    expect(actions.listActions({}, db)).toHaveLength(0);
    expect(listHistory({}, db).some((h) => h.event_type === "followup.superseded")).toBe(true);
  });

  it("Outlook indisponible : aucune supposition, aucune relance, nouvelle tentative programmée", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphDown();
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client });
    expect(r.outcome).toBe("check_failed");
    const after = followupsRepo.getFollowup(f.id, db)!;
    expect(after.status).toBe("CHECK_FAILED");
    expect(after.execute_at > new Date().toISOString()).toBe(true);
    expect(after.last_error).toContain("Graph");
    expect(actions.listActions({}, db)).toHaveLength(0);
    expect(listHistory({}, db).some((h) => h.event_type === "followup.check_failed")).toBe(true);
    // Outlook non connecté : même comportement
    const f2 = makeFollowup(db, { emailId: outbound.id, reason: "Autre" });
    makeDue(db, f2.id);
    const r2 = await processFollowup(f2.id, { db, settings, graph: null });
    expect(r2.outcome).toBe("check_failed");
    expect(actions.listActions({}, db)).toHaveLength(0);
  });

  it("thread introuvable dans Outlook : aucune relance", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client });
    expect(r.outcome).toBe("check_failed");
    expect(actions.listActions({}, db)).toHaveLength(0);
  });

  it("aucune réponse : brouillon Claude → action reply_email à valider, carte WhatsApp, aucun envoi", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu sur l'intervention" });
    makeDue(db, f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    const anthropic = fakeAnthropic([{ output: DRAFT }]);
    const wa = fakeWhatsapp();
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: anthropic.client, whatsapp: wa.client, approverPhone: APPROVER });
    expect(r.outcome).toBe("draft_created");
    const action = actions.getAction(r.actionId!, db)!;
    expect(action.type).toBe("reply_email");
    expect(action.status).toBe("WAITING_APPROVAL");
    expect(action.requires_approval).toBe(1);
    const payload = parseJson<{ email_id: string; body: string; followup_id: string; attempt: number }>(action.payload, { email_id: "", body: "", followup_id: "", attempt: 0 });
    expect(payload.followup_id).toBe(f.id);
    expect(payload.attempt).toBe(1);
    expect(payload.email_id).toBe(outbound.id); // réponse dans le thread existant
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("WAITING_APPROVAL");
    expect(g.calls.some((c) => c.method === "POST")).toBe(false); // rien n'est parti
    // Carte WhatsApp dédiée
    const apr = approvals.getPendingApprovalForAction(action.id, db)!;
    const body = formatApprovalBody(buildApprovalMessageInput(action, apr, db));
    expect(body).toContain("🔁 EMA — Relance à valider");
    expect(body).toContain("Tentative : 1 / 2");
    expect(body).toContain("Réponse reçue : Aucune");
    expect(wa.sent()).toHaveLength(1);
    // Le thread est transmis comme donnée non fiable
    const user = String((anthropic.calls[0]?.params as { messages: { content: string }[] }).messages[0]?.content);
    expect(user).toMatch(/<untrusted_\w+_content/);
    expect(listHistory({}, db).map((h) => h.event_type)).toEqual(expect.arrayContaining(["followup.checked", "followup.due", "followup.draft_created", "followup.approval_requested"]));
  });

  it("Claude indisponible : relance en échec, récupérable, aucune action", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ error: timeoutError() }]).client });
    expect(r.outcome).toBe("failed");
    const after = followupsRepo.getFollowup(f.id, db)!;
    expect(after.status).toBe("FAILED");
    expect(after.last_error).toBeTruthy();
    expect(actions.listActions({}, db)).toHaveLength(0);
    // Récupération : nouvelle tentative possible
    const retry = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client });
    expect(retry.outcome).toBe("skipped"); // FAILED n'est pas repris automatiquement
    postponeFollowup(f.id, { in_days: 0, time: "00:00" }, { db, settings });
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("SCHEDULED");
  });

  it("relance jugée inutile par Claude : vérification humaine, aucun envoi", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: { ...DRAFT, followup_needed: false, reason: "La demande a déjà été traitée dans le thread" } }]).client });
    expect(r.outcome).toBe("not_needed");
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("REVIEW_REQUIRED");
    expect(actions.listActions({}, db)).toHaveLength(0);
  });

  it("validation : envoi réel via l'Action Engine, relance SENT, nouvel ancrage, tentative incrémentée", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    for (const ex of createOutlookExecutors({ db, client: g.client, contacts, settings })) registerExecutor(ex);
    const wa = fakeWhatsapp();
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: wa.client, approverPhone: APPROVER });
    const apr = approvals.getPendingApprovalForAction(r.actionId!, db)!;
    const decided = await handleWhatsappEvent(parseWebhook(buttonWebhook(APPROVER, `approve:${apr.id}`))[0]!, { db, settings, client: wa.client, approverPhone: APPROVER });
    expect(decided.outcome).toBe("approved");
    expect(actions.getAction(r.actionId!, db)?.status).toBe("COMPLETED");
    expect(g.calls.filter((c) => c.method === "POST" && c.url.endsWith("/reply"))).toHaveLength(1);
    reconcileFollowups({ db, settings, now: () => new Date("2026-09-15T09:00:00.000Z") });
    const after = followupsRepo.getFollowup(f.id, db)!;
    expect(after.status).toBe("SENT");
    expect(after.attempts).toBe(1);
    expect(after.watch_after).toBe("2026-09-15T09:00:00.000Z");
    expect(listHistory({}, db).some((h) => h.event_type === "followup.sent")).toBe(true);
  });

  it("refus : relance annulée, aucun email", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    for (const ex of createOutlookExecutors({ db, client: g.client, contacts, settings })) registerExecutor(ex);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: fakeWhatsapp().client, approverPhone: APPROVER });
    rejectAction(r.actionId!, "whatsapp", "Refusé", { db, settings });
    reconcileFollowups({ db, settings });
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("CANCELLED");
    expect(g.calls.some((c) => c.method === "POST" && c.url.endsWith("/reply"))).toBe(false);
  });

  it("modification du brouillon avant validation", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: fakeWhatsapp().client, approverPhone: APPROVER });
    const ctx = { db, settings, rules: [], companies: [], contacts, mode: "chat" as const };
    const updated = await executeTool("update_draft", { action_id: r.actionId!, body: `${DRAFT.body}\n\nC'est urgent.` }, ctx);
    expect(updated.ok).toBe(true);
    const action = actions.getAction(r.actionId!, db)!;
    expect(action.status).toBe("WAITING_APPROVAL");
    expect(parseJson<{ body: string }>(action.payload, { body: "" }).body).toContain("urgent");
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("WAITING_APPROVAL");
  });

  it("nombre maximal de relances atteint : aucune préparation, notification, décision humaine", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    followupsRepo.updateFollowup(f.id, { attempts: 2 }, db);
    makeDue(db, f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    const wa = fakeWhatsapp();
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: wa.client, approverPhone: APPROVER });
    expect(r.outcome).toBe("max_attempts");
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("MAX_ATTEMPTS_REACHED");
    expect(actions.listActions({}, db)).toHaveLength(0);
    expect(JSON.stringify(wa.sent())).toContain("Suivi sans réponse");
  });

  it("relance financière : le niveau de risque HIGH de l'action d'origine est conservé", async () => {
    const { outbound } = seedThread(db);
    const payment = actions.insertAction({ type: "payment_request", title: "Demande de règlement", payload: { email_id: outbound.id, to: ["nabila@gomu.fr"], subject: "Règlement", body: "Merci de régler.", supplier: "ABC", amount: 1000, currency: "EUR", due_date: null, project: null }, status: "COMPLETED", riskLevel: "HIGH", requiresApproval: true, sourceEmailId: outbound.id }, db);
    const f = scheduleFollowup({ emailId: outbound.id, reason: "Règlement non effectué", actionId: payment.id }, { db, settings });
    makeDue(db, f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: fakeWhatsapp().client, approverPhone: APPROVER });
    const action = actions.getAction(r.actionId!, db)!;
    expect(action.risk_level).toBe("HIGH");
    expect(action.requires_approval).toBe(1);
  });
});

describe("Idempotence, concurrence et reprise", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    resetToolsForTests();
    registerAllTools();
    clearExecutors();
    writeConfig("settings", settings);
  });
  afterEach(() => {
    resetToolsForTests();
    clearExecutors();
    fs.rmSync(privateRoot(), { recursive: true, force: true });
  });

  function dueFollowup() {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    return f;
  }

  it("deux cycles simultanés : une seule action, un seul brouillon", async () => {
    const f = dueFollowup();
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    const deps = { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: fakeWhatsapp().client, approverPhone: APPROVER };
    const [a, b] = await Promise.all([processDueFollowups(deps), processDueFollowups(deps)]);
    const outcomes = [...a, ...b].map((r) => r.outcome);
    expect(outcomes.filter((o) => o === "draft_created")).toHaveLength(1);
    expect(actions.listActions({}, db)).toHaveLength(1);
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("WAITING_APPROVAL");
  });

  it("brouillon déjà créé : nouvelle exécution réutilise l'action, jamais de doublon", async () => {
    const f = dueFollowup();
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    const deps = { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: fakeWhatsapp().client, approverPhone: APPROVER };
    const first = await processFollowup(f.id, deps);
    // Simule une reprise : la relance redevient traitable alors que l'action existe déjà
    db.prepare("UPDATE scheduled_followups SET status = 'SCHEDULED' WHERE id = ?").run(f.id);
    const second = await processFollowup(f.id, deps);
    expect(second.outcome).toBe("draft_reused");
    expect(second.actionId).toBe(first.actionId);
    expect(actions.listActions({}, db)).toHaveLength(1);
  });

  it("interruption pendant la vérification : la relance est reprise, pas bloquée", async () => {
    const f = dueFollowup();
    db.prepare("UPDATE scheduled_followups SET status = 'CHECKING', last_checked_at = ? WHERE id = ?").run("2026-09-15T07:00:00.000Z", f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    const results = await processDueFollowups({ db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client, whatsapp: fakeWhatsapp().client, approverPhone: APPROVER, now: () => new Date("2026-09-15T09:00:00.000Z") });
    expect(results.map((r) => r.outcome)).toContain("draft_created");
    expect(actions.listActions({}, db)).toHaveLength(1);
    // Une vérification récente appartient à un autre worker : on n'y touche pas
    const other = dueFollowup();
    db.prepare("UPDATE scheduled_followups SET status = 'CHECKING', last_checked_at = ? WHERE id = ?").run(new Date().toISOString(), other.id);
    const again = await processDueFollowups({ db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client });
    expect(again.some((r) => r.followupId === other.id)).toBe(false);
    expect(followupsRepo.getFollowup(other.id, db)?.status).toBe("CHECKING");
  });

  it("notification déjà envoyée : jamais renvoyée après un redémarrage", async () => {
    const f = dueFollowup();
    const wa = fakeWhatsapp();
    await notifyFollowup(f.id, "Premier envoi", { db, settings, whatsapp: wa.client, approverPhone: APPROVER });
    await notifyFollowup(f.id, "Second envoi", { db, settings, whatsapp: wa.client, approverPhone: APPROVER });
    await notifyFollowup(f.id, "Troisième envoi", { db, settings, whatsapp: wa.client, approverPhone: APPROVER });
    expect(wa.sent()).toHaveLength(1);
    expect(followupsRepo.getFollowup(f.id, db)?.notified_at).not.toBeNull();
  });

  it("WhatsApp indisponible : notification en attente, jamais considérée comme envoyée", async () => {
    const f = dueFollowup();
    const wa = fakeWhatsapp({ fail: () => json({ error: { message: "rate limited", code: 130429 } }, 429) });
    const ok = await notifyFollowup(f.id, "Rappel", { db, settings, whatsapp: wa.client, approverPhone: APPROVER });
    expect(ok).toBe(false);
    const after = followupsRepo.getFollowup(f.id, db)!;
    expect(after.notification_pending).toBe(1);
    expect(after.notified_at).toBeNull();
    expect(listHistory({}, db).some((h) => h.event_type === "followup.notification_pending")).toBe(true);
  });

  it("fenêtre WhatsApp fermée : template utilisé s'il est configuré, sinon notification différée", async () => {
    const outside = () => json({ error: { message: "outside window", code: 131047 } }, 400);
    const f1 = dueFollowup();
    const waNoTemplate = fakeWhatsapp({ fail: outside });
    expect(await notifyFollowup(f1.id, "Rappel", { db, settings, whatsapp: waNoTemplate.client, approverPhone: APPROVER })).toBe(false);
    expect(followupsRepo.getFollowup(f1.id, db)?.notification_pending).toBe(1);

    process.env.WHATSAPP_FOLLOWUP_TEMPLATE_NAME = "ema_followup";
    resetEnvCache();
    const f2 = dueFollowup();
    let n = 0;
    const waTemplate = fakeWhatsapp({ fail: () => (++n === 1 ? outside() : null) });
    const sent = await notifyFollowup(f2.id, "Rappel", { db, settings, whatsapp: waTemplate.client, approverPhone: APPROVER });
    delete process.env.WHATSAPP_FOLLOWUP_TEMPLATE_NAME;
    resetEnvCache();
    expect(sent).toBe(true);
    expect(JSON.stringify(waTemplate.sent())).toContain('"type":"template"');
    expect(followupsRepo.getFollowup(f2.id, db)?.notified_at).not.toBeNull();
  });
});

describe("Rappels internes", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    resetToolsForTests();
    registerAllTools();
    writeConfig("settings", settings);
  });
  afterEach(() => {
    resetToolsForTests();
    fs.rmSync(privateRoot(), { recursive: true, force: true });
  });

  it("rappel échu : message WhatsApp avec boutons, aucun email, aucune action", async () => {
    const f = scheduleFollowup({ kind: "INTERNAL_REMINDER", reason: "Revoir le devis ABC", title: "Signer le devis ABC", when: { in_days: 1 } }, { db, settings });
    expect(f.kind).toBe("INTERNAL_REMINDER");
    makeDue(db, f.id);
    const wa = fakeWhatsapp();
    const r = await processFollowup(f.id, { db, settings, whatsapp: wa.client, approverPhone: APPROVER, graph: null });
    expect(r.outcome).toBe("reminded");
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("REMINDED");
    expect(actions.listActions({}, db)).toHaveLength(0);
    const sent = JSON.stringify(wa.sent());
    expect(sent).toContain("EMA — Rappel");
    expect(sent).toContain(`done:${f.id}`);
    expect(sent).toContain(`snooze:${f.id}`);
  });

  it("boutons du rappel : terminé et reporter, dédoublonnés", async () => {
    const f = scheduleFollowup({ kind: "INTERNAL_REMINDER", reason: "Revoir le devis", title: "Devis ABC", when: { in_days: 1 } }, { db, settings });
    db.prepare("UPDATE scheduled_followups SET status = 'REMINDED' WHERE id = ?").run(f.id);
    expect(parseReminderButtonId(`done:${f.id}`)).toEqual({ decision: "done", followupId: f.id });
    const wa = fakeWhatsapp();
    const evt = parseWebhook(buttonWebhook(APPROVER, `snooze:${f.id}`, "wamid.rem1"))[0]!;
    const snoozed = await handleWhatsappEvent(evt, { db, settings, client: wa.client, approverPhone: APPROVER });
    expect(snoozed.route).toBe("REMINDER_INTERACTION");
    expect(snoozed.outcome).toBe("reminder_snoozed");
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("SCHEDULED");
    const replay = await handleWhatsappEvent(evt, { db, settings, client: wa.client, approverPhone: APPROVER });
    expect(replay.outcome).toBe("duplicate");
    const done = await handleWhatsappEvent(parseWebhook(buttonWebhook(APPROVER, `done:${f.id}`, "wamid.rem2"))[0]!, { db, settings, client: wa.client, approverPhone: APPROVER });
    expect(done.outcome).toBe("reminder_done");
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("DONE");
  });
});

describe("Pilotage des relances depuis WhatsApp", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    resetToolsForTests();
    registerAllTools();
    clearExecutors();
    writeConfig("contacts", { version: 1, contacts });
    writeConfig("settings", settings);
  });
  afterEach(() => {
    resetToolsForTests();
    clearExecutors();
    setFollowupGraphClientForTests(null);
    setAnthropicClientForTests(null);
    fs.rmSync(privateRoot(), { recursive: true, force: true });
  });

  const deps = (wa: ReturnType<typeof fakeWhatsapp>, anthropic: ReturnType<typeof fakeAnthropic>) => ({ db, settings, client: wa.client, anthropic: anthropic.client, approverPhone: APPROVER, assistantEnabled: true });
  const textEvent = (body: string, id?: string) => parseWebhook(textWebhook(APPROVER, body, id))[0]!;

  it("les outils de relance sont exposés à l'assistant", () => {
    for (const t of ["list_followups", "schedule_followup", "postpone_followup", "cancel_followup", "prepare_followup_now", "complete_reminder"]) {
      expect(WHATSAPP_TOOLS as readonly string[]).toContain(t);
    }
  });

  it("« relance Kevin dans 3 jours » : relance programmée, date calculée par le serveur", async () => {
    const { outbound } = seedThread(db);
    const wa = fakeWhatsapp();
    const anthropic = fakeAnthropic([], turn("schedule_followup", { email_id: outbound.id, reason: "Retour sur l'intervention", when: { in_days: 3 } }, "J'ai programmé une relance de Kevin dans 3 jours."));
    const r = await handleWhatsappEvent(textEvent("Relance Kevin dans 3 jours si je n'ai pas de réponse"), deps(wa, anthropic));
    expect(r.outcome).toBe("answered");
    const list = followupsRepo.listFollowups({}, db);
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("SCHEDULED");
    expect(list[0]?.recipient).toBe("kevin@abc.fr");
    expect((list[0]?.execute_at ?? "") > new Date().toISOString()).toBe(true);
  });

  it("« qui dois-je relancer aujourd'hui ? » puis « prépare le premier » : référence réelle réutilisée", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    const g = graphThread([message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" })]);
    saveTokenSet({ accessToken: "t", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, "moi@gomu.fr", db);
    setFollowupGraphClientForTests(() => g.client);
    const wa = fakeWhatsapp();
    // Le tool `prepare_followup_now` utilise le client Anthropic global : on l'injecte.
    const anthropic = fakeAnthropic([{ output: DRAFT }], [
      ...turn("list_followups", { scope: "today" }, "1. Kevin — retour attendu sur l'intervention"),
      ...turn("prepare_followup_now", { followup_id: f.id }, "J'ai préparé la relance de Kevin. Une validation est requise."),
    ]);
    setAnthropicClientForTests(anthropic.client as unknown as Anthropic);
    const listed = await handleWhatsappEvent(textEvent("Qui dois-je relancer aujourd'hui ?", "wamid.f1"), deps(wa, anthropic));
    expect(listed.outcome).toBe("answered");
    expect(lastRefs("WHATSAPP", db)[0]).toMatchObject({ index: 1, kind: "followup", id: f.id });

    const prepared = await handleWhatsappEvent(textEvent("Prépare le premier", "wamid.f2"), deps(wa, anthropic));
    // Le contexte du second tour contient l'identifiant réel de la relance
    expect(systemTextOf(anthropic.chatCalls[2]!.params)).toContain(f.id);
    expect(prepared.actionIds).toHaveLength(1);
    const action = actions.getAction(prepared.actionIds[0]!, db)!;
    expect(action.type).toBe("reply_email");
    expect(action.status).toBe("WAITING_APPROVAL");
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("WAITING_APPROVAL");
  });

  it("« reporte-la à vendredi » et « annule-la » : report puis annulation, sans doublon", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    const wa = fakeWhatsapp();
    const anthropic = fakeAnthropic([], [
      ...turn("postpone_followup", { followup_id: f.id, when: { weekday: "friday" } }, "Relance reportée à vendredi."),
      ...turn("cancel_followup", { followup_id: f.id, reason: "Plus nécessaire" }, "Relance annulée."),
    ]);
    await handleWhatsappEvent(textEvent("Reporte-la à vendredi", "wamid.p1"), deps(wa, anthropic));
    const postponed = followupsRepo.getFollowup(f.id, db)!;
    expect(postponed.status).toBe("SCHEDULED");
    expect(postponed.execute_at > f.execute_at).toBe(true);
    expect(followupsRepo.listFollowups({}, db)).toHaveLength(1);

    await handleWhatsappEvent(textEvent("Annule-la", "wamid.p2"), deps(wa, anthropic));
    expect(followupsRepo.getFollowup(f.id, db)?.status).toBe("CANCELLED");
    expect(listHistory({}, db).filter((h) => h.event_type === "followup.snoozed")).toHaveLength(1);
  });

  it("la préparation immédiate vérifie d'abord Outlook : une réponse arrivée annule la relance", async () => {
    const { outbound } = seedThread(db);
    const f = makeFollowup(db, { emailId: outbound.id, reason: "Retour attendu" });
    makeDue(db, f.id);
    saveTokenSet({ accessToken: "t", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, "moi@gomu.fr", db);
    const g = graphThread([
      message({ id: "g-out", conversationId: "conv-1", from: { emailAddress: { address: "moi@gomu.fr" } }, receivedDateTime: "2026-09-12T09:00:00Z", sentDateTime: "2026-09-12T09:00:00Z" }),
      message({ id: "g-reply", conversationId: "conv-1", from: { emailAddress: { address: "kevin@abc.fr" } }, body: { contentType: "text", content: "C'est noté, j'interviens mardi." }, receivedDateTime: "2026-09-14T08:00:00Z" }),
    ]);
    const r = await processFollowup(f.id, { db, settings, graph: g.client, client: fakeAnthropic([{ output: DRAFT }]).client });
    expect(r.outcome).toBe("response_received");
    expect(actions.listActions({}, db)).toHaveLength(0);
  });
});
