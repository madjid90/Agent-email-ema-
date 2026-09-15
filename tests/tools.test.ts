import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openIsolatedDb, type Db } from "@/database/connection";
import * as emails from "@/database/repositories/emails";
import { registerAllTools, resetToolsForTests, listTools, executeTool, toAnthropicTools, type ToolContext } from "@/tools";
import { settingsSchema } from "@/lib/config";
import { clearExecutors } from "@/actions/engine";

function ctx(db: Db, mode: ToolContext["mode"]): ToolContext {
  return {
    db,
    settings: settingsSchema.parse({ company: { name: "X", userName: "U", email: "u@x.fr" } }),
    rules: [],
    companies: [{ id: "entreprise-x", name: "Entreprise X", legalForm: "", siret: "", address: "", signatory: { name: "P", title: "Président" }, signaturePath: null, stampPath: null, aliases: [] }],
    contacts: [{ id: "c", name: "Compta", email: "compta@x.fr", role: "Comptabilité", internal: true }],
    mode,
  };
}

describe("Couche de tools", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    resetToolsForTests();
    registerAllTools();
    clearExecutors();
  });
  afterEach(() => resetToolsForTests());

  it("enregistre tous les tools prévus par TOOLS.md", () => {
    const names = listTools().map((t) => t.name);
    for (const n of ["get_new_emails", "get_email", "get_email_thread", "search_emails", "get_attachment", "reply_email", "forward_email", "send_email", "extract_pdf_text", "classify_document", "extract_invoice_data", "extract_quote_data", "archive_document", "prepare_payment_request", "prepare_deposit_request", "schedule_followup", "cancel_followup", "check_reply_received", "request_approval", "get_approval_status", "prepare_signed_document", "apply_signature", "apply_stamp"]) {
      expect(names).toContain(n);
    }
  });

  it("n'expose jamais les tools internes à Claude", () => {
    const exposed = toAnthropicTools("analyze").map((t) => t.name);
    expect(exposed).not.toContain("apply_signature");
    expect(exposed).not.toContain("apply_stamp");
    expect(exposed).not.toContain("send_whatsapp_notification");
    expect(exposed).toContain("reply_email");
    expect(exposed).toContain("prepare_signed_document");
    const def = toAnthropicTools("analyze").find((t) => t.name === "reply_email");
    expect(def?.input_schema.type).toBe("object");
  });

  it("valide l'entrée et refuse un tool hors mode", async () => {
    const bad = await executeTool("get_email", {}, ctx(db, "analyze"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("VALIDATION");
    const forbidden = await executeTool("search_emails", { query: "x" }, ctx(db, "analyze"));
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe("FORBIDDEN");
    const unknown = await executeTool("nope", {}, ctx(db, "chat"));
    expect(unknown.ok).toBe(false);
  });

  it("reply_email crée une action en attente de validation au lieu d'envoyer", async () => {
    const e = emails.insertEmail({ graphId: "g", threadId: "t", senderName: "Alexandre", senderEmail: "a@ext.fr", subject: "Paiement", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const r = await executeTool("reply_email", { email_id: e.id, body: "Le paiement sera fait vendredi." }, ctx(db, "chat"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { action_id: string; status: string; requires_approval: boolean };
      expect(data.status).toBe("WAITING_APPROVAL");
      expect(data.requires_approval).toBe(true);
    }
  });

  it("prepare_payment_request prépare un email interne HIGH sans jamais payer", async () => {
    const r = await executeTool("prepare_payment_request", { supplier: "Fournisseur Y", amount: 1200, subject: "Facture 42" }, ctx(db, "analyze"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { draft: string; status: string };
      expect(data.draft).toContain("procéder au règlement");
      expect(data.status).toBe("WAITING_APPROVAL");
    }
    const row = db.prepare("SELECT risk_level, payload FROM actions").get() as { risk_level: string; payload: string };
    expect(row.risk_level).toBe("HIGH");
    expect(JSON.parse(row.payload).to).toEqual(["compta@x.fr"]);
  });

  it("prepare_signed_document exige une signature et un tampon configurés", async () => {
    const e = emails.insertEmail({ graphId: "g2", subject: "Devis", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    db.prepare("INSERT INTO documents (id, email_id, name, original_path, created_at) VALUES ('doc_1', ?, 'devis.pdf', 'documents/devis.pdf', '2026-09-15T10:00:00.000Z')").run(e.id);
    const r = await executeTool("prepare_signed_document", { document_id: "doc_1", company_id: "entreprise-x", email_id: e.id, reply_body: "Ci-joint." }, ctx(db, "analyze"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CONFIG");
  });

  it("les tools non encore implémentés échouent proprement", async () => {
    const r = await executeTool("get_attachment", { email_id: "x", attachment_id: "y" }, ctx(db, "analyze"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("schedule_followup + check_reply_received", async () => {
    const e = emails.insertEmail({ graphId: "g3", threadId: "t3", direction: "outbound", subject: "Question", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    const r = await executeTool("schedule_followup", { email_id: e.id, execute_at: "2026-09-20T09:00:00.000Z", reason: "Pas de réponse" }, ctx(db, "analyze"));
    expect(r.ok).toBe(true);
    const none = await executeTool("check_reply_received", { thread_id: "t3", since: "2026-09-15T10:00:00.000Z" }, ctx(db, "followup"));
    expect(none.ok && (none.data as { replied: boolean }).replied).toBe(false);
    emails.insertEmail({ graphId: "g4", threadId: "t3", subject: "Re: Question", receivedAt: "2026-09-16T10:00:00.000Z" }, db);
    const yes = await executeTool("check_reply_received", { thread_id: "t3", since: "2026-09-15T10:00:00.000Z" }, ctx(db, "followup"));
    expect(yes.ok && (yes.data as { replied: boolean }).replied).toBe(true);
  });
});
