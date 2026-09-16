import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openIsolatedDb, type Db } from "@/database/connection";
import { GraphClient } from "@/integrations/microsoft/graph-client";
import { saveTokenSet } from "@/integrations/microsoft/token-store";
import { createOutlookExecutors } from "@/actions/executors/outlook";
import { approveAndExecute, clearExecutors, proposeAction, registerExecutor } from "@/actions/engine";
import * as emails from "@/database/repositories/emails";
import { settingsSchema, type Contact } from "@/lib/config";
import { fakeFetch, json, message, noSleep } from "./helpers/fake-graph";

describe("Exécuteurs Outlook (après validation uniquement)", () => {
  let db: Db;
  const settings = settingsSchema.parse({ company: { name: "X", userName: "U", email: "u@x.fr" } });
  // Destinataires autorisés : contacts configurés (phase 8A — plus d'adresse libre).
  const contacts: Contact[] = [
    { id: "magali", name: "Magali", email: "magali@exemple.fr", role: "Travaux", internal: true },
    { id: "compta", name: "Compta", email: "compta@x.fr", role: "Comptabilité", internal: true },
  ];

  beforeEach(() => {
    db = openIsolatedDb();
    saveTokenSet({ accessToken: "t", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, "moi@entreprise.fr", db);
    clearExecutors();
  });
  afterEach(() => clearExecutors());

  it("reply_email : aucun envoi avant validation, un seul POST /reply après, message envoyé tracé", async () => {
    const e = emails.insertEmail({ graphId: "g1", threadId: "conv", senderEmail: "client@ext.fr", subject: "Devis", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const { fetchImpl, calls } = fakeFetch([
      { match: /POST .*\/messages\/g1\/reply$/, handle: () => new Response(null, { status: 202 }) },
      { match: /GET .*\/sentitems\/messages\?/, handle: () => json({ value: [message({ id: "sent-1", conversationId: "conv", from: { emailAddress: { address: "moi@entreprise.fr" } }, sentDateTime: new Date().toISOString(), subject: "RE: Devis" })] }) },
    ]);
    for (const ex of createOutlookExecutors({ db, client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep }), contacts, settings })) registerExecutor(ex);

    const a = proposeAction({ type: "reply_email", title: "Répondre", payload: { email_id: e.id, body: "Bonjour, bien reçu." }, sourceEmailId: e.id }, { db, settings });
    expect(a.status).toBe("WAITING_APPROVAL");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    const done = await approveAndExecute(a.id, "whatsapp", { db, settings });
    expect(done.status).toBe("COMPLETED");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect((posts[0]?.body as { comment: string }).comment).toBe("Bonjour, bien reçu.");
    expect(emails.getEmailByGraphId("sent-1", db)?.direction).toBe("outbound");
    expect(emails.getEmail(e.id, db)?.status).toBe("PROCESSED");
  });

  it("forward_email et send_email construisent les bons corps Graph", async () => {
    const e = emails.insertEmail({ graphId: "g2", threadId: "conv2", subject: "Facture", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const { fetchImpl, calls } = fakeFetch([
      { match: /POST .*\/messages\/g2\/forward$/, handle: () => new Response(null, { status: 202 }) },
      { match: /POST .*\/me\/sendMail$/, handle: () => new Response(null, { status: 202 }) },
      { match: /GET .*\/sentitems/, handle: () => json({ value: [] }) },
    ]);
    for (const ex of createOutlookExecutors({ db, client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep }), contacts, settings })) registerExecutor(ex);

    const f = proposeAction({ type: "forward_email", title: "Transférer", payload: { email_id: e.id, to: ["magali@exemple.fr"], comment: "Pour traitement" }, sourceEmailId: e.id }, { db, settings });
    expect((await approveAndExecute(f.id, "user", { db, settings })).status).toBe("COMPLETED");
    const fwd = calls.find((c) => c.url.endsWith("/forward"))?.body as { toRecipients: { emailAddress: { address: string } }[]; comment: string };
    expect(fwd.toRecipients[0]?.emailAddress.address).toBe("magali@exemple.fr");

    const s = proposeAction({ type: "payment_request", title: "Règlement", payload: { email_id: null, to: ["compta@x.fr"], subject: "Règlement", body: "Merci de payer", supplier: "F", amount: 100, currency: "EUR", due_date: null, project: null } }, { db, settings });
    expect((await approveAndExecute(s.id, "user", { db, settings })).status).toBe("COMPLETED");
    const mail = calls.find((c) => c.url.endsWith("/sendMail"))?.body as { message: { subject: string; body: { contentType: string } }; saveToSentItems: boolean };
    expect(mail.message.subject).toBe("Règlement");
    expect(mail.message.body.contentType).toBe("Text");
    expect(mail.saveToSentItems).toBe(true);
  });

  it("destinataire hors politique : envoi refusé même si le payload le contient", async () => {
    const e = emails.insertEmail({ graphId: "g9", threadId: "conv9", senderEmail: "client@ext.fr", subject: "Facture", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const { fetchImpl, calls } = fakeFetch([
      { match: /POST .*\/forward$/, handle: () => new Response(null, { status: 202 }) },
      { match: /POST .*\/me\/sendMail$/, handle: () => new Response(null, { status: 202 }) },
    ]);
    for (const ex of createOutlookExecutors({ db, client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep }), contacts, settings })) registerExecutor(ex);

    const f = proposeAction({ type: "forward_email", title: "Transférer", payload: { email_id: e.id, to: ["inconnu@pirate.fr"], comment: "" }, sourceEmailId: e.id }, { db, settings });
    const forwarded = await approveAndExecute(f.id, "user", { db, settings });
    expect(forwarded.status).toBe("FAILED");
    expect(forwarded.error).toContain("Destinataire non autorisé");

    const s2 = proposeAction({ type: "send_email", title: "Envoyer", payload: { to: ["inconnu@pirate.fr"], subject: "x", body: "y", thread_id: null } }, { db, settings });
    expect((await approveAndExecute(s2.id, "user", { db, settings })).status).toBe("FAILED");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    // L'expéditeur réel du thread reste un destinataire légitime.
    const ok = proposeAction({ type: "forward_email", title: "Transférer", payload: { email_id: e.id, to: ["client@ext.fr"], comment: "" }, sourceEmailId: e.id }, { db, settings });
    expect((await approveAndExecute(ok.id, "user", { db, settings })).status).toBe("COMPLETED");
  });

  it("échec Graph à l'envoi → action FAILED, sans double envoi possible", async () => {
    const e = emails.insertEmail({ graphId: "g3", threadId: "c", subject: "x", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const { fetchImpl, calls } = fakeFetch([{ match: /POST .*\/reply$/, handle: () => json({ error: { code: "ErrorSendAsDenied" } }, 403) }]);
    for (const ex of createOutlookExecutors({ db, client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep }), contacts, settings })) registerExecutor(ex);
    const a = proposeAction({ type: "reply_email", title: "Répondre", payload: { email_id: e.id, body: "x" }, sourceEmailId: e.id }, { db, settings });
    const r = await approveAndExecute(a.id, "user", { db, settings });
    expect(r.status).toBe("FAILED");
    expect(r.error).toMatch(/403/);
    expect(calls).toHaveLength(1);
  });
});
