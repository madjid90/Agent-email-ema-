import { z } from "zod";
import { defineTool } from "../types";
import * as documentsRepo from "@/database/repositories/documents";
import * as emailsRepo from "@/database/repositories/emails";
import { logHistory } from "@/database/repositories/history";
import { listActions } from "@/database/repositories/actions";
import { parseJson, type DocumentRow } from "@/database/types";
import { EmaError } from "@/lib/errors";
import { ensureDocumentText } from "@/documents/extract-text";
import { analyzeDocument, readExtraction } from "@/documents/analyze";
import { classifyDocumentHeuristic } from "@/documents/classify";
import { documentTypeSchema, DOCUMENT_TYPE_LABELS, type DuplicateMatch } from "@/documents/types";
import { getLatestAnalysis } from "@/database/repositories/analyses";
import { evaluateRules } from "@/agent/rules";
import { resolvePaymentRecipient } from "@/documents/routing";
import { proposeAction } from "@/actions/engine";
import { actionRefSchema } from "../types";
import { formatAmount } from "@/lib/time";

function requireDoc(id: string, db: Parameters<typeof documentsRepo.getDocument>[1]): DocumentRow {
  const d = documentsRepo.getDocument(id, db);
  if (!d) throw new EmaError("NOT_FOUND", `Document ${id} introuvable`);
  return d;
}

const docSummarySchema = z.object({
  document_id: z.string(),
  name: z.string(),
  document_type: z.string().nullable(),
  document_type_label: z.string().nullable(),
  supplier_name: z.string().nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  due_date: z.string().nullable(),
  amount_excl_tax: z.number().nullable(),
  amount_incl_tax: z.number().nullable(),
  currency: z.string().nullable(),
  company_id: z.string().nullable(),
  confidence: z.number().nullable(),
  requires_human_review: z.boolean(),
  possible_duplicate: z.boolean(),
  duplicates: z.array(z.object({ document_id: z.string(), name: z.string(), reasons: z.array(z.string()) })),
  bank_details_change: z.boolean(),
  email_id: z.string().nullable(),
  email_subject: z.string().nullable(),
  received_at: z.string(),
  status: z.string(),
});

function toSummary(d: DocumentRow, db: Parameters<typeof documentsRepo.getDocument>[1]) {
  const email = d.email_id ? emailsRepo.getEmail(d.email_id, db) : undefined;
  return {
    document_id: d.id,
    name: d.name,
    document_type: d.doc_type,
    document_type_label: d.doc_type ? DOCUMENT_TYPE_LABELS[d.doc_type as keyof typeof DOCUMENT_TYPE_LABELS] ?? d.doc_type : null,
    supplier_name: d.supplier_name,
    invoice_number: d.invoice_number,
    invoice_date: d.invoice_date,
    due_date: d.due_date,
    amount_excl_tax: d.amount_excl_tax,
    amount_incl_tax: d.amount_incl_tax,
    currency: d.currency,
    company_id: d.company_id,
    confidence: d.doc_confidence,
    requires_human_review: d.requires_human_review === 1,
    possible_duplicate: d.possible_duplicate === 1,
    duplicates: parseJson<DuplicateMatch[]>(d.duplicate_of, []).map((m) => ({ document_id: m.document_id, name: m.name, reasons: m.reasons })),
    bank_details_change: d.bank_details_change === 1,
    email_id: d.email_id,
    email_subject: email?.subject ?? null,
    received_at: d.created_at,
    status: d.status,
  };
}

export const extractPdfText = defineTool({
  name: "extract_pdf_text",
  description: "Extrait (une seule fois) le texte d'un document PDF archivé et en renvoie le début.",
  riskLevel: "LOW",
  modes: ["analyze", "chat"],
  input: z.object({ document_id: z.string(), max_chars: z.number().int().min(100).max(50000).default(15000) }),
  output: z.object({ text: z.string(), pages: z.number().int(), truncated: z.boolean(), status: z.string() }),
  handler: async (input, ctx) => {
    const d = await ensureDocumentText(requireDoc(input.document_id, ctx.db), ctx.db);
    const text = d.extracted_text ?? "";
    return { text: text.slice(0, input.max_chars), pages: d.text_pages ?? 0, truncated: text.length > input.max_chars, status: d.text_status };
  },
});

export const classifyDocument = defineTool({
  name: "classify_document",
  description: "Classe un document (facture, avoir, devis, justificatif de paiement, RIB, bon de commande, contrat, autre).",
  riskLevel: "LOW",
  modes: ["analyze", "chat"],
  input: z.object({ document_id: z.string() }),
  output: z.object({ type: documentTypeSchema, confidence: z.number().min(0).max(1), source: z.enum(["analysis", "heuristic"]) }),
  handler: async (input, ctx) => {
    const d = await ensureDocumentText(requireDoc(input.document_id, ctx.db), ctx.db);
    if (d.doc_type && d.doc_confidence !== null) return { type: documentTypeSchema.parse(d.doc_type), confidence: d.doc_confidence, source: "analysis" as const };
    const hint = classifyDocumentHeuristic(d.name, d.extracted_text);
    return { type: hint.type, confidence: Math.min(0.5, hint.score / 10), source: "heuristic" as const };
  },
});

export const extractInvoiceData = defineTool({
  name: "extract_invoice_data",
  description: "Renvoie les données structurées extraites d'une facture ou d'un avoir (fournisseur, numéro, montants, échéance, société, avertissements, doublons).",
  riskLevel: "LOW",
  modes: ["analyze", "chat"],
  input: z.object({ document_id: z.string() }),
  output: docSummarySchema.extend({ vat_amount: z.number().nullable(), warnings: z.array(z.string()), summary: z.string().nullable() }),
  handler: async (input, ctx) => {
    const d = requireDoc(input.document_id, ctx.db);
    const r = d.analyzed_at ? { document: d, extraction: readExtraction(d) } : await analyzeDocument(d.id, { db: ctx.db, settings: ctx.settings, companies: ctx.companies });
    return { ...toSummary(r.document, ctx.db), vat_amount: r.extraction?.vat_amount ?? null, warnings: r.extraction?.warnings ?? [], summary: r.extraction?.summary ?? null };
  },
});

export const extractQuoteData = defineTool({
  name: "extract_quote_data",
  description: "Renvoie les données structurées extraites d'un devis (fournisseur, société, montant, date, référence).",
  riskLevel: "LOW",
  modes: ["analyze", "chat"],
  input: z.object({ document_id: z.string() }),
  output: docSummarySchema.extend({ signature_requested: z.boolean(), summary: z.string().nullable() }),
  handler: async (input, ctx) => {
    const d = requireDoc(input.document_id, ctx.db);
    const r = d.analyzed_at ? { document: d, extraction: readExtraction(d) } : await analyzeDocument(d.id, { db: ctx.db, settings: ctx.settings, companies: ctx.companies });
    const text = (r.document.extracted_text ?? "").toLowerCase();
    return { ...toSummary(r.document, ctx.db), signature_requested: /bon pour accord|retour(ner)? sign|signature/.test(text), summary: r.extraction?.summary ?? null };
  },
});

export const archiveDocument = defineTool({
  name: "archive_document",
  description: "Classe un document archivé dans une catégorie (facture, devis, signé, autre) et l'associe à une société.",
  riskLevel: "LOW",
  modes: ["analyze", "chat"],
  input: z.object({ document_id: z.string(), category: z.enum(["invoice", "quote", "signed", "other"]), company_id: z.string().nullable().default(null) }),
  output: z.object({ document_id: z.string(), category: z.string() }),
  handler: async (input, ctx) => {
    const d = requireDoc(input.document_id, ctx.db);
    if (input.company_id && !ctx.companies.some((c) => c.id === input.company_id)) throw new EmaError("VALIDATION", `Société inconnue : ${input.company_id}`);
    documentsRepo.updateDocument(d.id, { category: input.category, company_id: input.company_id, status: "archived" }, ctx.db);
    logHistory({ eventType: "document.archived", message: `Document ${d.name} archivé (${input.category})`, documentId: d.id, emailId: d.email_id }, ctx.db);
    return { document_id: d.id, category: input.category };
  },
});

export const searchDocuments = defineTool({
  name: "search_documents",
  description: "Recherche des documents archivés (factures, avoirs, justificatifs…) par fournisseur, numéro de facture, type, date ou mots-clés.",
  riskLevel: "LOW",
  modes: ["chat", "analyze"],
  input: z.object({ query: z.string().optional(), supplier: z.string().optional(), invoice_number: z.string().optional(), document_type: documentTypeSchema.optional(), since: z.string().optional(), requires_review: z.boolean().optional(), possible_duplicate: z.boolean().optional(), max: z.number().int().min(1).max(50).default(20) }),
  output: z.array(docSummarySchema),
  handler: async (input, ctx) =>
    documentsRepo.searchDocuments({ query: input.query, supplier: input.supplier, invoiceNumber: input.invoice_number, docType: input.document_type, since: input.since, requiresReview: input.requires_review, possibleDuplicate: input.possible_duplicate, limit: input.max }, ctx.db).map((d) => toSummary(d, ctx.db)),
});

export const getDocument = defineTool({
  name: "get_document",
  description: "Renvoie le détail d'un document archivé et ses données extraites.",
  riskLevel: "LOW",
  modes: ["chat", "analyze"],
  input: z.object({ document_id: z.string() }),
  output: docSummarySchema.extend({ warnings: z.array(z.string()), summary: z.string().nullable(), text_status: z.string() }),
  handler: async (input, ctx) => {
    const d = requireDoc(input.document_id, ctx.db);
    const x = readExtraction(d);
    return { ...toSummary(d, ctx.db), warnings: x?.warnings ?? [], summary: x?.summary ?? null, text_status: d.text_status };
  },
});

export const listPendingActions = defineTool({
  name: "list_pending_actions",
  description: "Liste les actions en attente de validation (réponses, transferts de factures, demandes de règlement).",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ max: z.number().int().min(1).max(50).default(20) }),
  output: z.array(z.object({ action_id: z.string(), type: z.string(), title: z.string(), status: z.string(), risk_level: z.string(), email_id: z.string().nullable(), document_id: z.string().nullable(), created_at: z.string() })),
  handler: async (input, ctx) =>
    listActions({ status: ["WAITING_APPROVAL", "PROPOSED"], limit: input.max }, ctx.db).map((a) => ({ action_id: a.id, type: a.type, title: a.title, status: a.status, risk_level: a.risk_level, email_id: a.source_email_id, document_id: a.document_id, created_at: a.created_at })),
});

export const prepareDocumentForward = defineTool({
  name: "prepare_document_forward",
  description: "Prépare le transfert d'un document (facture, avoir…) à la personne désignée par les règles de routage. Le destinataire est déterminé par config/rules.json puis par les contacts internes : il n'est jamais choisi librement. Crée une action à valider.",
  riskLevel: "MEDIUM",
  modes: ["chat"],
  input: z.object({ document_id: z.string(), comment: z.string().optional() }),
  output: actionRefSchema.extend({ to: z.array(z.string()), rule_id: z.string().nullable(), comment: z.string() }),
  handler: async (input, ctx) => {
    const d = requireDoc(input.document_id, ctx.db);
    if (!d.email_id) throw new EmaError("VALIDATION", "Ce document n'est rattaché à aucun email : transfert impossible");
    const email = emailsRepo.getEmail(d.email_id, ctx.db);
    if (!email) throw new EmaError("NOT_FOUND", `Email ${d.email_id} introuvable`);
    if (d.bank_details_change === 1) throw new EmaError("VALIDATION", "Changement de coordonnées bancaires détecté : vérification humaine requise avant tout transfert");
    const analysis = getLatestAnalysis(email.id, ctx.db);
    const outcome = evaluateRules(ctx.rules, {
      category: (analysis?.category as Parameters<typeof evaluateRules>[1]["category"]) ?? null,
      supplier: d.supplier_name ?? analysis?.company_name ?? null,
      senderEmail: email.sender_email,
      subject: email.subject,
      companyId: d.company_id ?? analysis?.company_id ?? null,
      amount: d.amount_incl_tax ?? analysis?.amount_value ?? null,
    });
    const to = outcome.forwardTo ?? resolvePaymentRecipient(outcome, ctx.contacts);
    if (!to) throw new EmaError("CONFIG", "Aucune règle ni contact interne ne désigne de destinataire pour ce document : ajoutez une règle dans config/rules.json");
    const amount = d.amount_incl_tax !== null ? ` (${formatAmount(d.amount_incl_tax, d.currency ?? "EUR")} TTC)` : "";
    const comment =
      input.comment ??
      ["Bonjour,", "", `Pouvez-vous prendre en charge ce document${d.supplier_name ? ` ${d.supplier_name}` : ""}${d.invoice_number ? ` n° ${d.invoice_number}` : ""}${amount}${d.due_date ? `, échéance ${d.due_date}` : ""} ?`, "", "Merci.", "", ctx.settings.agent.signatureText].join("\n").trim();
    const a = proposeAction(
      {
        type: "forward_email",
        title: `Transférer ${d.supplier_name ?? d.name}${d.invoice_number ? ` n° ${d.invoice_number}` : ""} à ${to}`,
        payload: { email_id: email.id, to: [to], comment },
        sourceEmailId: email.id,
        documentId: d.id,
        companyId: d.company_id,
        requiresApproval: true,
        actor: "user",
      },
      { db: ctx.db, settings: ctx.settings },
    );
    logHistory({ eventType: "rule.applied", message: `Transfert préparé vers ${to}${outcome.forwardRule ? ` (règle ${outcome.forwardRule.id})` : " (contact interne)"}`, actor: "user", actionId: a.id, emailId: email.id, documentId: d.id }, ctx.db);
    return { action_id: a.id, status: a.status, requires_approval: a.requires_approval === 1, to: [to], rule_id: outcome.forwardRule?.id ?? null, comment };
  },
});

export const documentTools = [extractPdfText, classifyDocument, extractInvoiceData, extractQuoteData, archiveDocument, searchDocuments, getDocument, listPendingActions, prepareDocumentForward];
