import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { openIsolatedDb, type Db } from "@/database/connection";
import { GraphClient } from "@/integrations/microsoft/graph-client";
import { syncInbox, importConversation, getSyncState } from "@/integrations/microsoft/sync";
import { saveTokenSet } from "@/integrations/microsoft/token-store";
import { isDangerousAttachment, storeAttachment, ingestEmailAttachments } from "@/integrations/microsoft/attachments";
import { htmlToText, searchMessages } from "@/integrations/microsoft/mail";
import * as emails from "@/database/repositories/emails";
import * as documents from "@/database/repositories/documents";
import { listHistory } from "@/database/repositories/history";
import { fakeFetch, json, binary, message, noSleep } from "./helpers/fake-graph";
import { registerAllTools, resetToolsForTests, executeTool, type ToolContext } from "@/tools";
import { setGraphClientFactoryForTests } from "@/tools/outlook";
import { settingsSchema } from "@/lib/config";
import { privateRoot } from "@/lib/paths";

function client(fetchImpl: typeof fetch): GraphClient {
  return new GraphClient({ getAccessToken: async () => "tok", fetchImpl, sleep: noSleep });
}

function connect(db: Db): void {
  saveTokenSet({ accessToken: "tok", refreshToken: "rt", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, "moi@entreprise.fr", db);
}

// Requête delta initiale uniquement : les nextLink/deltaLink ont leurs propres routes.
const DELTA = /GET .*\/me\/mailFolders\/inbox\/messages\/delta\?\$select/;

describe("Synchronisation Outlook", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    connect(db);
  });
  afterEach(() => fs.rmSync(privateRoot(), { recursive: true, force: true }));

  it("ingère les nouveaux emails, conserve le deltaLink et ignore les doublons au passage suivant", async () => {
    let deltaCalls = 0;
    const { fetchImpl, calls } = fakeFetch([
      { match: DELTA, handle: () => { deltaCalls++; return json({ value: [message({ id: "m1" }), message({ id: "m2", receivedDateTime: "2026-09-15T11:00:00Z" })], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc" }); } },
      { match: /GET .*\$deltatoken=abc/, handle: () => json({ value: [message({ id: "m2", isRead: true }), message({ id: "m3" })], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=def" }) },
    ]);
    const first = await syncInbox(client(fetchImpl), { db, limit: 10, initialSyncDays: 7, now: () => new Date("2026-09-15T12:00:00Z") });
    expect(first.inserted).toBe(2);
    expect(first.lastEmailAt).toBe("2026-09-15T11:00:00Z");
    expect(calls[0]?.url).toContain("$filter=receivedDateTime+ge+2026-09-08T12%3A00%3A00.000Z");
    expect(calls[0]?.headers.prefer).toContain('outlook.body-content-type="text"');
    expect(emails.getEmailByGraphId("m1", db)?.status).toBe("NEW");
    expect(emails.getEmailByGraphId("m1", db)?.internet_message_id).toBe("<m1@example.com>");

    const second = await syncInbox(client(fetchImpl), { db, limit: 10 });
    expect(second.inserted).toBe(1);
    expect(second.updated).toBe(1);
    expect(deltaCalls).toBe(1);
    expect(emails.getEmailByGraphId("m2", db)?.is_read).toBe(1);
    expect(emails.countEmails({}, db)).toBe(3);
    expect(getSyncState(db).hasCursor).toBe(true);
    expect(listHistory({}, db).some((h) => h.event_type === "outlook.sync")).toBe(true);
  });

  it("respecte la limite par passage en reprenant sur le nextLink", async () => {
    const { fetchImpl } = fakeFetch([
      { match: DELTA, handle: () => json({ value: [message({ id: "a" }), message({ id: "b" })], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=1" }) },
      { match: /GET .*\$skiptoken=1/, handle: () => json({ value: [message({ id: "c" })], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=z" }) },
    ]);
    const r1 = await syncInbox(client(fetchImpl), { db, limit: 2, initialSyncDays: 0 });
    expect(r1.inserted).toBe(2);
    expect(r1.reachedLimit).toBe(true);
    const r2 = await syncInbox(client(fetchImpl), { db, limit: 2 });
    expect(r2.inserted).toBe(1);
    expect(r2.reachedLimit).toBe(false);
    expect(emails.countEmails({}, db)).toBe(3);
  });

  it("ignore les brouillons et les entrées supprimées, enregistre une erreur Graph sans perdre l'état", async () => {
    const { fetchImpl } = fakeFetch([{ match: DELTA, handle: () => json({ value: [message({ id: "d", isDraft: true }), { id: "gone", "@removed": { reason: "deleted" } }, message({ id: "ok" })], "@odata.deltaLink": "https://g/delta?$deltatoken=1" }) }]);
    const r = await syncInbox(client(fetchImpl), { db, limit: 10 });
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(1);

    const broken = fakeFetch([{ match: /deltatoken=1/, handle: () => json({ error: { code: "ServiceUnavailable" } }, 503) }]);
    const r2 = await syncInbox(new GraphClient({ getAccessToken: async () => "t", fetchImpl: broken.fetchImpl, sleep: noSleep, maxRetries: 1 }), { db, limit: 10 });
    expect(r2.errors).toHaveLength(1);
    expect(getSyncState(db).lastSyncError).toMatch(/503/);
  });

  it("télécharge les pièces jointes fichier, refuse les dangereuses et les trop grosses", async () => {
    const pdf = Buffer.from("%PDF-1.4 fake");
    const { fetchImpl } = fakeFetch([
      { match: DELTA, handle: () => json({ value: [message({ id: "att", hasAttachments: true })], "@odata.deltaLink": "https://g/delta?$deltatoken=1" }) },
      { match: /GET .*\/messages\/att\/attachments\?/, handle: () => json({ value: [
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "a1", name: "../../devis (v2).pdf", contentType: "application/pdf", size: pdf.length },
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "a2", name: "facture.pdf.exe", contentType: "application/octet-stream", size: 10 },
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "a3", name: "gros.zip", contentType: "application/zip", size: 50 * 1024 * 1024 },
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "a4", name: "logo.png", contentType: "image/png", size: 10, isInline: true },
        { "@odata.type": "#microsoft.graph.itemAttachment", id: "a5", name: "mail joint", size: 10 },
      ] }) },
      { match: /GET .*\/attachments\/a1\/\$value/, handle: () => binary(pdf) },
    ]);
    const r = await syncInbox(client(fetchImpl), { db, limit: 10, maxAttachmentBytes: 1024 * 1024 });
    expect(r.inserted).toBe(1);
    expect(r.attachments).toBe(1);
    const email = emails.getEmailByGraphId("att", db)!;
    const docs = documents.listDocuments({ emailId: email.id }, db);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.name).toBe("../../devis (v2).pdf");
    expect(docs[0]?.stored_name).toMatch(/^doc_[a-f0-9]+-devis_v2_\.pdf$/);
    expect(docs[0]?.original_path).toMatch(/^documents\/2026\/09\/doc_/);
    expect(docs[0]?.sha256).toHaveLength(64);
    expect(fs.existsSync(`${privateRoot()}/${docs[0]?.original_path}`)).toBe(true);
    const refused = listHistory({ emailId: email.id }, db).filter((h) => h.event_type === "document.refused");
    expect(refused).toHaveLength(2);

    // Re-synchroniser ne duplique pas le document
    const again = await ingestEmailAttachments(client(fetchImpl), email, 1024 * 1024, db);
    expect(again.stored).toHaveLength(0);
    expect(again.skipped.find((s) => s.name.includes("devis"))?.reason).toBe("exists");
  });

  it("storeAttachment refuse explicitement le dangereux et le trop volumineux", () => {
    const email = emails.insertEmail({ graphId: "x", subject: "x", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    expect(isDangerousAttachment("script.js", "text/plain")).toBe(true);
    expect(isDangerousAttachment("devis.pdf", "application/pdf")).toBe(false);
    expect(isDangerousAttachment("archive.tar", "application/x-sh")).toBe(true);
    expect(() => storeAttachment({ email, meta: { id: "1", name: "run.bat", contentType: "text/plain", size: 3, isInline: false, isFile: true }, bytes: Buffer.from("abc"), maxBytes: 100 }, db)).toThrow(/dangereux/);
    expect(() => storeAttachment({ email, meta: { id: "2", name: "big.pdf", contentType: "application/pdf", size: 3, isInline: false, isFile: true }, bytes: Buffer.alloc(200), maxBytes: 100 }, db)).toThrow(/volumineuse/);
  });

  it("importe une conversation en CONTEXT, triée, avec la direction déduite du compte", async () => {
    const mine = emails.insertEmail({ graphId: "m-new", threadId: "conv-1", subject: "Question", receivedAt: "2026-09-16T10:00:00.000Z" }, db);
    const { fetchImpl, calls } = fakeFetch([{ match: /GET .*\/me\/messages\?/, handle: () => json({ value: [
      message({ id: "m-new", receivedDateTime: "2026-09-16T10:00:00Z" }),
      message({ id: "m-old", receivedDateTime: "2026-09-10T10:00:00Z", from: { emailAddress: { address: "moi@entreprise.fr" } }, subject: "Ma demande" }),
      message({ id: "draft", isDraft: true }),
    ] }) }]);
    const thread = await importConversation(client(fetchImpl), "conv-1", { db, max: 20 });
    expect(calls[0]?.url).toContain("conversationId+eq+%27conv-1%27");
    expect(thread.map((e) => e.graph_id)).toEqual(["m-old", "m-new"]);
    expect(thread[0]?.status).toBe("CONTEXT");
    expect(thread[0]?.direction).toBe("outbound");
    expect(thread[1]?.id).toBe(mine.id);
    expect(emails.countEmails({}, db)).toBe(1); // CONTEXT n'est pas compté comme email à traiter
  });

  it("recherche : KQL $search, résultats bornés, brouillons exclus", async () => {
    const { fetchImpl, calls } = fakeFetch([{ match: /GET .*\/me\/messages\?/, handle: () => json({ value: [message({ id: "s1" }), message({ id: "s2", isDraft: true })] }) }]);
    const found = await searchMessages(client(fetchImpl), { query: 'facture "42"', from: "compta@x.fr", since: "2026-09-01", max: 5 });
    expect(found.map((m) => m.id)).toEqual(["s1"]);
    expect(decodeURIComponent(calls[0]?.url ?? "").replace(/\+/g, " ")).toContain('$search="facture  42 " from:compta@x.fr received>=2026-09-01');
  });

  it("convertit du HTML en texte", () => {
    expect(htmlToText("<p>Bonjour,</p><br><div>Voici &amp; le <b>devis</b></div><style>x{}</style>")).toBe("Bonjour,\n\nVoici & le devis");
  });
});

describe("Tools Outlook branchés sur Graph", () => {
  let db: Db;
  const ctx = (): ToolContext => ({ db, settings: settingsSchema.parse({ company: { name: "X", userName: "U", email: "u@x.fr" } }), rules: [], companies: [], contacts: [], mode: "chat" });

  beforeEach(() => {
    db = openIsolatedDb();
    resetToolsForTests();
    registerAllTools();
  });
  afterEach(() => {
    setGraphClientFactoryForTests(null);
    resetToolsForTests();
    fs.rmSync(privateRoot(), { recursive: true, force: true });
  });

  it("get_email_thread et get_attachment passent par Graph quand Outlook est connecté", async () => {
    connect(db);
    const e = emails.insertEmail({ graphId: "g1", threadId: "conv-9", subject: "Devis", receivedAt: "2026-09-15T10:00:00.000Z", hasAttachments: true }, db);
    const pdf = Buffer.from("%PDF-1.4");
    const { fetchImpl } = fakeFetch([
      { match: /GET .*\/me\/messages\?/, handle: () => json({ value: [message({ id: "g0", conversationId: "conv-9", receivedDateTime: "2026-09-14T10:00:00Z" }), message({ id: "g1", conversationId: "conv-9" })] }) },
      { match: /GET .*\/messages\/g1\/attachments\?/, handle: () => json({ value: [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "a1", name: "devis.pdf", contentType: "application/pdf", size: pdf.length }] }) },
      { match: /GET .*\/attachments\/a1\/\$value/, handle: () => binary(pdf) },
    ]);
    setGraphClientFactoryForTests(() => client(fetchImpl));

    const thread = await executeTool("get_email_thread", { email_id: e.id }, ctx());
    expect(thread.ok).toBe(true);
    if (thread.ok) expect((thread.data as { subject: string }[]).map((m) => m.subject)).toEqual(["Sujet g0", "Devis"]);

    const full = await executeTool("get_email", { email_id: e.id }, ctx());
    expect(full.ok).toBe(true);
    if (full.ok) expect((full.data as { attachments: { attachment_id: string; document_id: string | null }[] }).attachments).toEqual([{ attachment_id: "a1", name: "devis.pdf", mime: "application/pdf", size: pdf.length, document_id: null }]);

    const att = await executeTool("get_attachment", { email_id: e.id, attachment_id: "a1" }, ctx());
    expect(att.ok).toBe(true);
    if (att.ok) expect((att.data as { name: string }).name).toBe("devis.pdf");
    const again = await executeTool("get_attachment", { email_id: e.id, attachment_id: "a1" }, ctx());
    expect(again.ok && (again.data as { document_id: string }).document_id).toBe(att.ok ? (att.data as { document_id: string }).document_id : "");
  });

  it("sans connexion Outlook : thread local, get_attachment refuse proprement", async () => {
    const e = emails.insertEmail({ graphId: "g1", threadId: "t", subject: "Local", receivedAt: "2026-09-15T10:00:00.000Z", hasAttachments: true }, db);
    const thread = await executeTool("get_email_thread", { email_id: e.id }, ctx());
    expect(thread.ok && (thread.data as unknown[]).length).toBe(1);
    const att = await executeTool("get_attachment", { email_id: e.id, attachment_id: "a1" }, ctx());
    expect(att.ok).toBe(false);
    if (!att.ok) expect(att.error.code).toBe("CONFIG");
  });
});
