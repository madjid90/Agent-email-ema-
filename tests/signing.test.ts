import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { openIsolatedDb, type Db } from "@/database/connection";
import * as documents from "@/database/repositories/documents";
import * as actions from "@/database/repositories/actions";
import * as approvals from "@/database/repositories/approvals";
import * as emails from "@/database/repositories/emails";
import { listHistory } from "@/database/repositories/history";
import { buildSignedPdf } from "@/documents/sign-pdf";
import { loadAsset, pngDimensions, assetStatus } from "@/documents/assets";
import { checkSignatureReadiness, prepareQuoteSignature, createSignedCopy } from "@/documents/sign";
import { analyzeDocument } from "@/documents/analyze";
import { applyDocumentGuards } from "@/documents/invoice";
import { extractPdfText } from "@/documents/extract-text";
import { documentExtractionSchema, type DocumentExtraction } from "@/documents/types";
import { analyzeEmail } from "@/agent/orchestrator";
import { runChatTurn, CHAT_READONLY_TOOLS } from "@/agent/chat";
import { approveAndExecute, rejectAction, retryAction, clearExecutors, registerExecutor } from "@/actions/engine";
import { createSigningExecutor } from "@/actions/executors/signing";
import { GraphClient } from "@/integrations/microsoft/graph-client";
import { saveTokenSet } from "@/integrations/microsoft/token-store";
import { handleInboundEvent, notifyPendingApproval, buildApprovalMessageInput } from "@/integrations/whatsapp/approvals";
import { parseWebhook } from "@/integrations/whatsapp/webhook";
import { formatApprovalBody } from "@/integrations/whatsapp/messages";
import { registerAllTools, resetToolsForTests, executeTool, listTools, toAnthropicTools } from "@/tools";
import { settingsSchema, writeConfig, type Company, type Contact } from "@/lib/config";
import { privateRoot, ensureDir } from "@/lib/paths";
import { makeCompany } from "./helpers/config";
import { makePng } from "./helpers/png-fixture";
import { makeTextPdf, makeBlankPdf, makeEncryptedPdf, seedPdfDocument } from "./helpers/pdf-fixtures";
import { fakeAnthropic, analysisFixture } from "./helpers/fake-anthropic";
import { fakeWhatsapp, buttonWebhook } from "./helpers/fake-whatsapp";
import { fakeFetch, json, message, noSleep } from "./helpers/fake-graph";

const APPROVER = "33612345678";
const settings = settingsSchema.parse({ company: { name: "GOMU", userName: "Madjid", email: "moi@gomu.fr", timezone: "Europe/Paris" }, agent: { signatureText: "Cordialement,\nMadjid" } });
const contacts: Contact[] = [];

const QUOTE_LINES = ["ABC Securite SAS", "DEVIS N° D-2026-458", "Date : 10/09/2026", "Valable jusqu'au 10/10/2026", "Client : GOMU La Valette", "Objet : Installation videosurveillance", "Montant HT : 4 041,67 EUR", "TVA 20 % : 808,33 EUR", "Montant TTC : 4 850,00 EUR", "Merci de nous retourner ce devis signe avec la mention Bon pour accord."];

function quoteExtraction(over: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return documentExtractionSchema.parse({
    document_type: "QUOTE", summary: "Devis d'installation de vidéosurveillance.", supplier_name: "ABC Sécurité", supplier_email: "devis@abc-securite.fr", invoice_number: null, quote_number: "D-2026-458",
    invoice_date: "2026-09-10", due_date: null, valid_until: "2026-10-10", subject: "Installation vidéosurveillance", payment_terms: "30 % à la commande", delivery_or_service_date: null, signature_requested: true,
    purchase_order_number: null, customer_company_name: "GOMU La Valette", company_id: "gomu83", amount_excl_tax: 4041.67, vat_amount: 808.33, amount_incl_tax: 4850, currency: "EUR",
    deposit_amount: null, deposit_percent: 30, total_amount: null, iban_present: false, iban_last4: null, bank_details_change_suspected: false, payment_reference: null,
    document_confidence: 0.95, requires_human_review: false, warnings: [], injection_suspected: false,
    ...over,
  });
}

/** Sociétés de test : assets PNG générés dans private/ (jamais de vraie signature). */
function setupCompanies(opts: { stamp?: boolean; stampRequired?: boolean; placement?: Company["signaturePlacement"]; signature?: boolean } = {}): Company[] {
  ensureDir(path.join(privateRoot(), "signatures"));
  ensureDir(path.join(privateRoot(), "stamps"));
  if (opts.signature !== false) fs.writeFileSync(path.join(privateRoot(), "signatures", "gomu83-signature.png"), makePng(300, 100));
  if (opts.stamp !== false) fs.writeFileSync(path.join(privateRoot(), "stamps", "gomu83-stamp.png"), makePng(150, 150, [200, 0, 0, 255]));
  return [
    makeCompany({ id: "gomu83", name: "GOMU La Valette", legalName: "GOMU SAS", signatory: { name: "Madjid S.", title: "Président" }, signaturePath: opts.signature === false ? null : "signatures/gomu83-signature.png", stampPath: opts.stamp === false ? null : "stamps/gomu83-stamp.png", stampRequired: opts.stampRequired ?? false, signaturePlacement: opts.placement ?? { mode: "APPEND_APPROVAL_PAGE" }, aliases: ["GOMU"] }),
    makeCompany({ id: "gomu06", name: "GOMU Nice", aliases: ["GOMU"] }),
  ];
}

function graphOk() {
  const { fetchImpl, calls } = fakeFetch([
    { match: /POST .*\/messages\/[^/]+\/reply$/, handle: () => new Response(null, { status: 202 }) },
    { match: /GET .*\/sentitems\/messages\?/, handle: () => json({ value: [message({ id: "sent-signed", conversationId: "t-doc", from: { emailAddress: { address: "moi@gomu.fr" } }, sentDateTime: new Date().toISOString() })] }) },
  ]);
  return { client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep }), calls };
}
function graphFailing() {
  const { fetchImpl, calls } = fakeFetch([{ match: /POST .*\/reply$/, handle: () => json({ error: { code: "ServiceUnavailable" } }, 503) }]);
  return { client: new GraphClient({ getAccessToken: async () => "t", fetchImpl, sleep: noSleep, maxRetries: 0 }), calls };
}

describe("Génération du PDF signé (pdf-lib)", () => {
  it("APPEND_APPROVAL_PAGE : page ajoutée, original intact, texte d'accord et date présents", async () => {
    const original = await makeTextPdf(QUOTE_LINES);
    const before = createHash("sha256").update(original).digest("hex");
    const signed = await buildSignedPdf({ original, approvalText: "Bon pour accord", dateText: "15/09/2026", companyName: "GOMU SAS", signerName: "Madjid S.", signerTitle: "Président", signature: makePng(300, 100), stamp: makePng(150, 150), placement: { mode: "APPEND_APPROVAL_PAGE" } });
    expect(createHash("sha256").update(original).digest("hex")).toBe(before);
    expect(createHash("sha256").update(signed).digest("hex")).not.toBe(before);
    const doc = await PDFDocument.load(signed);
    expect(doc.getPageCount()).toBe(2);
    const text = await extractPdfText(signed);
    expect(text.text).toContain("BON POUR ACCORD");
    expect(text.text).toContain("15/09/2026");
    expect(text.text).toContain("Madjid S., Président");
    expect(text.text).toContain("DEVIS N° D-2026-458");
  });

  it("OVERLAY_LAST_PAGE : aucune page ajoutée, texte apposé sur la dernière page", async () => {
    const original = await makeTextPdf(QUOTE_LINES);
    const signed = await buildSignedPdf({ original, approvalText: "Bon pour accord", dateText: "15/09/2026", companyName: "GOMU SAS", signerName: null, signerTitle: null, signature: makePng(300, 100), stamp: null, placement: { mode: "OVERLAY_LAST_PAGE", page: "last", approvalText: { x: 60, y: 140 }, date: { x: 60, y: 120 }, signature: { x: 60, y: 40, width: 160, height: 60 } } });
    const doc = await PDFDocument.load(signed);
    expect(doc.getPageCount()).toBe(1);
    const text = await extractPdfText(signed);
    expect(text.text).toContain("Bon pour accord");
    expect(text.text).toContain("Le 15/09/2026");
  });

  it("PDF corrompu, chiffré ou image illisible → erreur, jamais contournée", async () => {
    await expect(buildSignedPdf({ original: Buffer.from("%PDF-1.4 garbage"), approvalText: "x", dateText: "x", companyName: "x", signerName: null, signerTitle: null, signature: null, stamp: null, placement: { mode: "APPEND_APPROVAL_PAGE" } })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(buildSignedPdf({ original: makeEncryptedPdf(), approvalText: "x", dateText: "x", companyName: "x", signerName: null, signerTitle: null, signature: null, stamp: null, placement: { mode: "APPEND_APPROVAL_PAGE" } })).rejects.toThrow(/protégé/);
    await expect(buildSignedPdf({ original: await makeTextPdf(["x"]), approvalText: "x", dateText: "x", companyName: "x", signerName: null, signerTitle: null, signature: Buffer.from("not png"), stamp: null, placement: { mode: "APPEND_APPROVAL_PAGE" } })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("Assets de signature / tampon", () => {
  afterEach(() => fs.rmSync(privateRoot(), { recursive: true, force: true }));

  it("charge un PNG valide, refuse absent / non PNG / trop grand / dimensions aberrantes", () => {
    const [company] = setupCompanies();
    const sig = loadAsset(company!, "signature");
    expect(sig.width).toBe(300);
    expect(sig.label).toBe("Signature Madjid S.");
    expect(pngDimensions(makePng(20, 20))).toEqual({ width: 20, height: 20 });
    expect(assetStatus(company!, "stamp").available).toBe(true);
    const missing = makeCompany({ id: "x", name: "X", signaturePath: "signatures/absent.png" });
    expect(() => loadAsset(missing, "signature")).toThrow(/introuvable/);
    expect(assetStatus(missing, "signature")).toEqual({ configured: true, available: false });
    expect(() => loadAsset(makeCompany({ id: "y", name: "Y" }), "signature")).toThrow(/non configuré/);
    fs.writeFileSync(path.join(privateRoot(), "signatures", "bad.png"), Buffer.from("<svg onload=alert(1)></svg>"));
    expect(() => loadAsset(makeCompany({ id: "z", name: "Z", signaturePath: "signatures/bad.png" }), "signature")).toThrow(/PNG/);
    fs.writeFileSync(path.join(privateRoot(), "signatures", "tiny.png"), makePng(5, 5));
    expect(() => loadAsset(makeCompany({ id: "t", name: "T", signaturePath: "signatures/tiny.png" }), "signature")).toThrow(/dimensions/);
    expect(() => loadAsset(makeCompany({ id: "p", name: "P", signaturePath: "../etc/passwd.png" }), "signature")).toThrow(/invalide/);
  });
});

describe("Garde-fous devis et préparation de la signature", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
  });
  afterEach(() => fs.rmSync(privateRoot(), { recursive: true, force: true }));

  const guard = (x: DocumentExtraction, companies: Company[], today = "2026-09-15") => applyDocumentGuards(x, { companies, hint: { type: "QUOTE", score: 2, ibanPresent: false, ibanLast4: null, bankChangeSuspected: false }, heuristicInjection: false, reviewThreshold: 0.6, today });

  it("devis valide, devis expiré, montant incohérent, société inconnue / ambiguë, sans montant", () => {
    const companies = setupCompanies();
    expect(guard(quoteExtraction(), companies).requires_human_review).toBe(false);
    const expired = guard(quoteExtraction(), companies, "2026-11-01");
    expect(expired.requires_human_review).toBe(true);
    expect(expired.warnings.some((w) => w.startsWith("QUOTE_EXPIRED"))).toBe(true);
    expect(guard(quoteExtraction({ amount_incl_tax: 9999 }), companies).warnings.some((w) => w.includes("incohérents"))).toBe(true);
    const unknown = guard(quoteExtraction({ company_id: "nope", customer_company_name: "Inconnue" }), companies);
    expect(unknown.company_id).toBeNull();
    expect(unknown.requires_human_review).toBe(true);
    const ambiguous = guard(quoteExtraction({ company_id: null, customer_company_name: "GOMU" }), companies);
    expect(ambiguous.company_id).toBeNull();
    expect(ambiguous.warnings.some((w) => w.includes("Plusieurs sociétés"))).toBe(true);
    const noAmount = guard(quoteExtraction({ amount_excl_tax: null, vat_amount: null, amount_incl_tax: null }), companies);
    expect(noAmount.amount_incl_tax).toBeNull();
    expect(noAmount.requires_human_review).toBe(true);
    // Le numéro de facture d'un devis est reclassé en référence de devis
    expect(guard(quoteExtraction({ quote_number: null, invoice_number: "D-1" }), companies).quote_number).toBe("D-1");
  });

  async function seedQuote(companies: Company[], over: Partial<DocumentExtraction> = {}, lines = QUOTE_LINES) {
    const seeded = await seedPdfDocument(db, await makeTextPdf(lines), { name: "devis.pdf", subject: "Devis à signer", body: "Merci de nous retourner le devis signé.", sender: "devis@abc-securite.fr" });
    const { client } = fakeAnthropic([{ output: quoteExtraction(over) }]);
    await analyzeDocument(seeded.documentId, { db, settings, companies, client });
    return seeded;
  }

  it("préparation : action CRITICAL avec payload déterministe, sans chemin ni base64", async () => {
    const companies = setupCompanies();
    const s = await seedQuote(companies);
    const r = prepareQuoteSignature(s.documentId, "gomu83", { db, settings, companies });
    expect(r.actionId).not.toBeNull();
    const a = actions.getAction(r.actionId!, db)!;
    expect(a.type).toBe("sign_document");
    expect(a.risk_level).toBe("CRITICAL");
    expect(a.requires_approval).toBe(1);
    expect(a.status).toBe("WAITING_APPROVAL");
    expect(a.company_id).toBe("gomu83");
    const payload = JSON.parse(a.payload);
    expect(payload).toMatchObject({ company_id: "gomu83", supplier_name: "ABC Sécurité", quote_number: "D-2026-458", amount_incl_tax: 4850, approval_text: "Bon pour accord", signature_required: true, stamp_required: true, placement_strategy: "APPEND_APPROVAL_PAGE", return_to_original_sender: true, reply_to: "devis@abc-securite.fr", signature_label: "Signature Madjid S.", stamp_label: "Tampon GOMU La Valette" });
    expect(payload.reply_body).toContain("devis signé");
    expect(JSON.stringify(payload)).not.toMatch(/signatures\/|stamps\/|base64|iVBOR/);
    expect(documents.getDocument(s.documentId, db)?.status).toBe("sign_proposed");
    // Idempotent : une seule action
    expect(prepareQuoteSignature(s.documentId, "gomu83", { db, settings, companies }).actionId).toBe(r.actionId);
    expect(actions.listActionsForEmail(s.emailId, db)).toHaveLength(1);
    // Message WhatsApp
    const apr = approvals.getPendingApprovalForAction(a.id, db)!;
    const body = formatApprovalBody(buildApprovalMessageInput(a, apr, db));
    expect(body).toContain("📄 EMA — Devis à signer");
    expect(body).toContain("Devis : D-2026-458");
    expect(body).toContain("✓ Bon pour accord");
    expect(body).toContain("✓ Signature Madjid S.");
    expect(body).toContain("✓ Tampon GOMU La Valette");
    expect(body).toContain("appliquera réellement votre signature");
    expect(body).not.toMatch(/signatures\/|stamps\//);
  });

  it("refus : signature absente, tampon obligatoire absent, société manquante / inconnue, contrat, injection, devis déjà signé", async () => {
    const noSig = setupCompanies({ signature: false });
    const s1 = await seedQuote(noSig);
    const r1 = prepareQuoteSignature(s1.documentId, "gomu83", { db, settings, companies: noSig });
    expect(r1.actionId).toBeNull();
    expect(r1.readiness.reasons[0]).toContain("Signature non configurée");
    expect(listHistory({ emailId: s1.emailId }, db).some((h) => h.event_type === "signature.blocked")).toBe(true);

    const noStamp = setupCompanies({ stamp: false, stampRequired: true });
    const s2 = await seedQuote(noStamp);
    expect(prepareQuoteSignature(s2.documentId, "gomu83", { db, settings, companies: noStamp }).readiness.reasons[0]).toContain("Tampon obligatoire");

    const companies = setupCompanies();
    const s3 = await seedQuote(companies, { company_id: null, customer_company_name: null });
    expect(prepareQuoteSignature(s3.documentId, null, { db, settings, companies }).readiness.reasons[0]).toContain("Société non déterminée");
    expect(prepareQuoteSignature(s3.documentId, "inconnue", { db, settings, companies }).readiness.reasons[0]).toContain("Société inconnue");

    const s4 = await seedQuote(companies, { document_type: "CONTRACT" });
    const r4 = prepareQuoteSignature(s4.documentId, "gomu83", { db, settings, companies });
    expect(r4.actionId).toBeNull();
    expect(r4.readiness.reasons[0]).toContain("Document contractuel détecté");

    const s5 = await seedQuote(companies, { injection_suspected: true });
    expect(prepareQuoteSignature(s5.documentId, "gomu83", { db, settings, companies }).readiness.reasons.some((x) => x.includes("Instructions suspectes"))).toBe(true);

    const s6 = await seedQuote(companies);
    documents.updateDocument(s6.documentId, { signed_document_id: "doc_already" }, db);
    expect(prepareQuoteSignature(s6.documentId, "gomu83", { db, settings, companies }).readiness.reasons[0]).toContain("déjà été signé");
  });

  it("devis expiré, changement de RIB et montant élevé : signalés mais validation humaine possible", async () => {
    const companies = setupCompanies();
    const s = await seedQuote(companies, { valid_until: "2020-01-01", bank_details_change_suspected: true, amount_incl_tax: 25000, amount_excl_tax: 20833.33, vat_amount: 4166.67 });
    const r = prepareQuoteSignature(s.documentId, "gomu83", { db, settings, companies });
    expect(r.actionId).not.toBeNull();
    expect(r.readiness.quoteExpired).toBe(true);
    expect(r.readiness.bankChange).toBe(true);
    expect(r.readiness.highAmount).toBe(true);
    const payload = JSON.parse(actions.getAction(r.actionId!, db)!.payload);
    expect(payload.quote_expired).toBe(true);
    expect(payload.warnings.some((w: string) => w.includes("expiré depuis le 01/01/2020"))).toBe(true);
    expect(payload.warnings.some((w: string) => w.includes("coordonnées bancaires"))).toBe(true);
    expect(payload.warnings.some((w: string) => w.includes("Montant élevé"))).toBe(true);
    const apr = approvals.getPendingApprovalForAction(r.actionId!, db)!;
    expect(formatApprovalBody(buildApprovalMessageInput(actions.getAction(r.actionId!, db)!, apr, db))).toContain("expiré depuis le 01/01/2020");
    expect(documents.getDocument(s.documentId, db)?.requires_human_review).toBe(1);
  });

  it("PDF sans texte : signature impossible", async () => {
    const companies = setupCompanies();
    const seeded = await seedPdfDocument(db, await makeBlankPdf(), { name: "scan.pdf" });
    await analyzeDocument(seeded.documentId, { db, settings, companies, client: fakeAnthropic([]).client });
    const readiness = checkSignatureReadiness(documents.getDocument(seeded.documentId, db)!, "gomu83", { db, settings, companies });
    expect(readiness.ok).toBe(false);
  });
});

describe("Exécution de la signature (Action Engine + WhatsApp + Graph mockés)", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    clearExecutors();
    saveTokenSet({ accessToken: "t", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: "" }, "moi@gomu.fr", db);
  });
  afterEach(() => {
    clearExecutors();
    fs.rmSync(privateRoot(), { recursive: true, force: true });
  });

  async function prepared(companies: Company[], over: Partial<DocumentExtraction> = {}) {
    const seeded = await seedPdfDocument(db, await makeTextPdf(QUOTE_LINES), { name: "devis.pdf", subject: "Devis", body: "Merci de retourner le devis signé.", sender: "devis@abc-securite.fr" });
    await analyzeDocument(seeded.documentId, { db, settings, companies, client: fakeAnthropic([{ output: quoteExtraction(over) }]).client });
    const r = prepareQuoteSignature(seeded.documentId, "gomu83", { db, settings, companies });
    return { ...seeded, actionId: r.actionId! };
  }

  it("validation WhatsApp : copie signée créée, original intact, chaînage en base, réponse Graph avec le seul PDF signé, COMPLETED", async () => {
    const companies = setupCompanies();
    const s = await prepared(companies);
    const g = graphOk();
    registerExecutor(createSigningExecutor({ db, client: g.client, settings, companies }));
    const wa = fakeWhatsapp();
    await notifyPendingApproval(s.actionId, { db, client: wa.client, approverPhone: APPROVER, settings });
    const apr = approvals.getPendingApprovalForAction(s.actionId, db)!;
    const originalBefore = fs.readFileSync(path.join(privateRoot(), documents.getDocument(s.documentId, db)!.original_path));
    const r = await handleInboundEvent(parseWebhook(buttonWebhook(APPROVER, `approve:${apr.id}`))[0]!, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(r.outcome).toBe("approved");
    const action = actions.getAction(s.actionId, db)!;
    expect(action.status).toBe("COMPLETED");
    const original = documents.getDocument(s.documentId, db)!;
    expect(original.status).toBe("signed_and_sent");
    expect(original.signed_document_id).not.toBeNull();
    expect(original.signed_action_id).toBe(s.actionId);
    expect(original.signed_approval_id).toBe(apr.id);
    expect(fs.readFileSync(path.join(privateRoot(), original.original_path)).equals(originalBefore)).toBe(true);
    expect(createHash("sha256").update(originalBefore).digest("hex")).toBe(original.sha256);
    const signed = documents.getDocument(original.signed_document_id!, db)!;
    expect(signed.parent_document_id).toBe(original.id);
    expect(signed.category).toBe("signed");
    expect(signed.sha256).not.toBe(original.sha256);
    expect(signed.original_path).toMatch(/^signed-documents\/\d{4}\/\d{2}\/doc_.*-signed-\d{8}\.pdf$/);
    expect(signed.status).toBe("sent");
    const signedBytes = fs.readFileSync(path.join(privateRoot(), signed.original_path));
    expect((await extractPdfText(signedBytes)).text).toContain("BON POUR ACCORD");
    // Graph : une réponse dans le thread, une seule pièce jointe = le PDF signé
    const reply = g.calls.find((c) => c.method === "POST" && c.url.endsWith("/reply"))!;
    const body = reply.body as { comment: string; message: { attachments: { name: string; contentType: string; contentBytes: string }[] } };
    expect(body.comment).toContain("devis signé");
    expect(body.message.attachments).toHaveLength(1);
    expect(body.message.attachments[0]?.name).toBe(signed.name);
    expect(Buffer.from(body.message.attachments[0]!.contentBytes, "base64").equals(signedBytes)).toBe(true);
    expect(emails.getEmail(s.emailId, db)?.status).toBe("PROCESSED");
    const events = listHistory({ emailId: s.emailId }, db).map((h) => h.event_type);
    expect(events).toEqual(expect.arrayContaining(["signature.proposed", "approval.sent", "approval.approved", "signature.assets_selected", "document.signed", "document.signed_sent", "action.completed"]));
    const all = JSON.stringify(listHistory({ emailId: s.emailId }, db));
    expect(all).not.toMatch(/iVBOR|base64/);
  });

  it("refus : aucune copie signée, aucun envoi", async () => {
    const companies = setupCompanies();
    const s = await prepared(companies);
    const g = graphOk();
    registerExecutor(createSigningExecutor({ db, client: g.client, settings, companies }));
    rejectAction(s.actionId, "whatsapp", "Refusé", { db, settings });
    expect(actions.getAction(s.actionId, db)?.status).toBe("REJECTED");
    expect(documents.getDocument(s.documentId, db)?.signed_document_id).toBeNull();
    expect(documents.listDocuments({ category: "signed" }, db)).toHaveLength(0);
    expect(g.calls).toHaveLength(0);
  });

  it("Graph échoue après signature : FAILED, copie signée conservée ; retry réutilise le même PDF et envoie une seule fois", async () => {
    const companies = setupCompanies();
    const s = await prepared(companies);
    const bad = graphFailing();
    registerExecutor(createSigningExecutor({ db, client: bad.client, settings, companies }));
    const failed = await approveAndExecute(s.actionId, "user", { db, settings });
    expect(failed.status).toBe("FAILED");
    const original = documents.getDocument(s.documentId, db)!;
    expect(original.signed_document_id).not.toBeNull();
    expect(original.status).toBe("signed"); // signé mais jamais « envoyé »
    const signedId = original.signed_document_id!;
    const signedHash = documents.getDocument(signedId, db)!.sha256;
    expect(documents.listDocuments({ category: "signed" }, db)).toHaveLength(1);

    clearExecutors();
    const good = graphOk();
    registerExecutor(createSigningExecutor({ db, client: good.client, settings, companies }));
    // Phase 8A : un échec 503 sur un envoi est « ambigu » — EMA vérifie d'abord
    // les éléments envoyés (vides ici) avant d'autoriser un nouvel essai.
    expect(actions.getAction(s.actionId, db)?.error_code).toBe("DELIVERY_AMBIGUOUS");
    // Réconciliation : aucun envoi trouvé dans les éléments envoyés → nouvel essai autorisé.
    const retried = await retryAction(s.actionId, "user", { db, settings, reconcile: async () => ({ verdict: "not_sent", detail: "aucun envoi correspondant" }) });
    expect(retried.status).toBe("COMPLETED");
    expect(documents.listDocuments({ category: "signed" }, db)).toHaveLength(1);
    expect(documents.getDocument(s.documentId, db)?.signed_document_id).toBe(signedId);
    expect(documents.getDocument(signedId, db)?.sha256).toBe(signedHash);
    expect(good.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(listHistory({ emailId: s.emailId }, db).some((h) => h.event_type === "document.signed_reused")).toBe(true);
  });

  it("double validation, rejeu webhook et validation UI simultanée : une seule copie, un seul envoi", async () => {
    const companies = setupCompanies();
    const s = await prepared(companies);
    const g = graphOk();
    registerExecutor(createSigningExecutor({ db, client: g.client, settings, companies }));
    const wa = fakeWhatsapp();
    const apr = approvals.getPendingApprovalForAction(s.actionId, db)!;
    const evt = buttonWebhook(APPROVER, `approve:${apr.id}`, "wamid.sign");
    const results = await Promise.allSettled([
      handleInboundEvent(parseWebhook(evt)[0]!, { db, client: wa.client, approverPhone: APPROVER, settings }),
      approveAndExecute(s.actionId, "user", { db, settings }),
    ]);
    await handleInboundEvent(parseWebhook(evt)[0]!, { db, client: wa.client, approverPhone: APPROVER, settings });
    await handleInboundEvent(parseWebhook(buttonWebhook(APPROVER, `approve:${apr.id}`, "wamid.sign2"))[0]!, { db, client: wa.client, approverPhone: APPROVER, settings });
    expect(results.length).toBe(2);
    expect(actions.getAction(s.actionId, db)?.status).toBe("COMPLETED");
    expect(documents.listDocuments({ category: "signed" }, db)).toHaveLength(1);
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("PDF protégé : exécution FAILED, aucune copie, aucun envoi, original jamais envoyé comme signé", async () => {
    const companies = setupCompanies();
    const seeded = await seedPdfDocument(db, makeEncryptedPdf(), { name: "devis-protege.pdf", sender: "devis@abc-securite.fr" });
    // Texte injecté manuellement (le PDF protégé n'a pas de texte extractible)
    documents.updateDocument(seeded.documentId, { text_status: "extracted", extracted_text: QUOTE_LINES.join("\n"), text_pages: 1 }, db);
    await analyzeDocument(seeded.documentId, { db, settings, companies, client: fakeAnthropic([{ output: quoteExtraction() }]).client });
    const r = prepareQuoteSignature(seeded.documentId, "gomu83", { db, settings, companies });
    expect(r.actionId).not.toBeNull();
    const g = graphOk();
    registerExecutor(createSigningExecutor({ db, client: g.client, settings, companies }));
    const res = await approveAndExecute(r.actionId!, "user", { db, settings });
    expect(res.status).toBe("FAILED");
    expect(actions.getAction(r.actionId!, db)?.error).toMatch(/protégé|ne peut pas être signé/);
    expect(documents.listDocuments({ category: "signed" }, db)).toHaveLength(0);
    expect(documents.getDocument(seeded.documentId, db)?.signed_document_id).toBeNull();
    expect(g.calls).toHaveLength(0);
  });

  it("mauvais company_id ou empreinte modifiée : exécution refusée", async () => {
    const companies = setupCompanies();
    const s = await prepared(companies);
    const payload = JSON.parse(actions.getAction(s.actionId, db)!.payload);
    await expect(createSignedCopy({ ...payload, company_id: "gomu06" }, s.actionId, { db, settings, companies })).rejects.toThrow(/Signature non configurée/);
    await expect(createSignedCopy({ ...payload, company_id: "nope" }, s.actionId, { db, settings, companies })).rejects.toMatchObject({ code: "CONFIG" });
    const doc = documents.getDocument(s.documentId, db)!;
    fs.appendFileSync(path.join(privateRoot(), doc.original_path), "\n% tampered");
    await expect(createSignedCopy(payload, s.actionId, { db, settings, companies })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("flux complet analyzeEmail : email « retourner le devis signé » → analyse → action CRITICAL + WhatsApp, jamais signé sans validation", async () => {
    const companies = setupCompanies();
    const seeded = await seedPdfDocument(db, await makeTextPdf(QUOTE_LINES), { name: "devis.pdf", subject: "Devis", body: "Bonjour, merci de nous retourner le devis signé afin de lancer l'intervention.", sender: "devis@abc-securite.fr" });
    const { client, calls } = fakeAnthropic([
      { output: analysisFixture({ category: "DOCUMENT_TO_SIGN", needs_reply: false, reply_draft: null, recommended_action: "sign_document", company_id: "gomu83", requires_human_review: true }) },
      { output: quoteExtraction() },
    ]);
    const wa = fakeWhatsapp();
    const r = await analyzeEmail(seeded.emailId, { db, settings, companies, contacts, rules: [], client, whatsapp: { db, settings, client: wa.client, approverPhone: APPROVER } });
    expect(r.actionIds).toHaveLength(1);
    const a = actions.getAction(r.actionIds[0]!, db)!;
    expect(a.type).toBe("sign_document");
    expect(a.status).toBe("WAITING_APPROVAL");
    expect(wa.sent()).toHaveLength(1);
    expect(documents.listDocuments({ category: "signed" }, db)).toHaveLength(0);
    // Claude n'a jamais reçu les PNG : aucune donnée d'image dans les requêtes
    const sentToClaude = JSON.stringify(calls.map((c) => c.params));
    expect(sentToClaude).not.toMatch(/iVBOR|signatures\/|stamps\/|\.png/);
    // Réanalyse : pas de seconde action ni de second message
    const again = await analyzeEmail(seeded.emailId, { db, settings, companies, contacts, rules: [], client: fakeAnthropic([{ output: analysisFixture({ category: "DOCUMENT_TO_SIGN", needs_reply: false, reply_draft: null, recommended_action: "sign_document", company_id: "gomu83" }) }, { output: quoteExtraction() }]).client, force: true, whatsapp: { db, settings, client: wa.client, approverPhone: APPROVER } });
    expect(again.actionIds).toEqual(r.actionIds);
    expect(wa.sent()).toHaveLength(1);
  });

  it("un email demandant de signer un CONTRAT ne crée aucune action de signature", async () => {
    const companies = setupCompanies();
    const seeded = await seedPdfDocument(db, await makeTextPdf(["CONTRAT DE MAINTENANCE", "Le present contrat..."]), { name: "contrat.pdf", subject: "Contrat", body: "Merci de signer ce contrat.", sender: "juridique@abc.fr" });
    const { client } = fakeAnthropic([
      { output: analysisFixture({ category: "DOCUMENT_TO_SIGN", needs_reply: false, reply_draft: null, recommended_action: "sign_document", company_id: "gomu83" }) },
      { output: quoteExtraction({ document_type: "CONTRACT", quote_number: null, subject: "Contrat de maintenance" }) },
    ]);
    const r = await analyzeEmail(seeded.emailId, { db, settings, companies, contacts, rules: [], client, whatsapp: { db, settings, client: fakeWhatsapp().client, approverPhone: APPROVER } });
    expect(r.actionIds).toHaveLength(0);
    expect(documents.getDocument(seeded.documentId, db)?.requires_human_review).toBe(1);
    expect(listHistory({ emailId: seeded.emailId }, db).some((h) => h.message.includes("Document contractuel détecté"))).toBe(true);
  });
});

describe("Tools et chat : Claude ne voit que company_id", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    resetToolsForTests();
    registerAllTools();
  });
  afterEach(() => {
    resetToolsForTests();
    fs.rmSync(privateRoot(), { recursive: true, force: true });
  });

  it("apply_signature / apply_stamp n'existent pas comme tools ; prepare_signed_document crée une action CRITICAL", async () => {
    const names = listTools().map((t) => t.name);
    expect(names).not.toContain("apply_signature");
    expect(names).not.toContain("apply_stamp");
    const exposed = toAnthropicTools("chat");
    const def = exposed.find((t) => t.name === "prepare_signed_document")!;
    expect(def).toBeDefined();
    expect(JSON.stringify(def.input_schema)).not.toMatch(/path|base64|png/i);
    expect(CHAT_READONLY_TOOLS).toContain("prepare_signed_document");

    const companies = setupCompanies();
    const seeded = await seedPdfDocument(db, await makeTextPdf(QUOTE_LINES), { name: "devis.pdf", sender: "devis@abc-securite.fr" });
    await analyzeDocument(seeded.documentId, { db, settings, companies, client: fakeAnthropic([{ output: quoteExtraction() }]).client });
    const ctx = { db, settings, rules: [], companies, contacts, mode: "chat" as const };
    const r = await executeTool("prepare_signed_document", { document_id: seeded.documentId, company_id: "gomu83" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { prepared: boolean; status: string; action_id: string };
      expect(data.prepared).toBe(true);
      expect(data.status).toBe("WAITING_APPROVAL");
      expect(JSON.stringify(data)).not.toMatch(/signatures\/|stamps\//);
    }
    expect(documents.listDocuments({ category: "signed" }, db)).toHaveLength(0);
    const bad = await executeTool("prepare_signed_document", { document_id: seeded.documentId, company_id: "nope" }, ctx);
    expect(bad.ok).toBe(false);
  });

  it("chat : « Signe le devis » prépare la demande sans signer", async () => {
    const companies = setupCompanies();
    writeConfig("companies", { version: 1, companies }); // le chat lit config/companies.json
    const seeded = await seedPdfDocument(db, await makeTextPdf(QUOTE_LINES), { name: "devis.pdf", sender: "devis@abc-securite.fr" });
    await analyzeDocument(seeded.documentId, { db, settings, companies, client: fakeAnthropic([{ output: quoteExtraction() }]).client });
    const { client } = fakeAnthropic([], [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "prepare_signed_document", input: { document_id: seeded.documentId, company_id: "gomu83" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "J'ai préparé la demande de signature. Une validation est requise.", citations: null }] },
    ]);
    const r = await runChatTurn("Signe le devis ABC", { db, settings, client });
    expect(r.toolCalls).toEqual([{ name: "prepare_signed_document", ok: true }]);
    expect(r.reply).toContain("validation est requise");
    expect(actions.listActionsForEmail(seeded.emailId, db).filter((a) => a.type === "sign_document" && a.status === "WAITING_APPROVAL")).toHaveLength(1);
    expect(documents.listDocuments({ category: "signed" }, db)).toHaveLength(0);
  });
});
