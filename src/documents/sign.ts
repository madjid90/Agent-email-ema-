import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as documentsRepo from "@/database/repositories/documents";
import * as emailsRepo from "@/database/repositories/emails";
import * as actionsRepo from "@/database/repositories/actions";
import { getLatestApprovalForAction } from "@/database/repositories/approvals";
import { logHistory } from "@/database/repositories/history";
import type { DocumentRow, EmailRow } from "@/database/types";
import { getCompanies, getSettings, type Company, type Settings } from "@/lib/config";
import { EmaError } from "@/lib/errors";
import { nowIso } from "@/lib/ids";
import { createLogger } from "@/lib/logger";
import { ensureDir, privatePath, privateRoot, safeJoin, sanitizeFilename } from "@/lib/paths";
import { formatAmount, formatDateOnly, todayInTimezone } from "@/lib/time";
import { proposeAction } from "@/actions/engine";
import type { ActionPayloadOutput } from "@/actions/types";
import { assetStatus, assetLabel, loadAsset } from "./assets";
import { buildSignedPdf } from "./sign-pdf";
import { readExtraction } from "./analyze";
import { QUOTE_EXPIRED_WARNING } from "./invoice";

const log = createLogger("documents.sign");

/**
 * Signature graphique d'un devis : préparation d'une action CRITICAL (jamais
 * exécutée sans validation) et exécution après validation (copie signée,
 * original intact, retour au fournisseur). Claude ne manipule que company_id.
 */

export interface SignatureReadiness {
  ok: boolean;
  reasons: string[];
  company: Company | null;
  signatureLabel: string | null;
  stampLabel: string | null;
  stampApplied: boolean;
  quoteExpired: boolean;
  expiredSince: string | null;
  bankChange: boolean;
  highAmount: boolean;
  amountUnknown: boolean;
  warnings: string[];
}

export interface PrepareDeps {
  db?: Db;
  settings?: Settings;
  companies?: Company[];
  actor?: "ema" | "user";
}

/** Vérifications déterministes avant toute proposition de signature. */
export function checkSignatureReadiness(doc: DocumentRow, companyId: string | null, deps: PrepareDeps = {}): SignatureReadiness {
  const settings = deps.settings ?? getSettings();
  const companies = deps.companies ?? getCompanies();
  const x = readExtraction(doc);
  const r: SignatureReadiness = { ok: true, reasons: [], company: null, signatureLabel: null, stampLabel: null, stampApplied: false, quoteExpired: false, expiredSince: null, bankChange: doc.bank_details_change === 1, highAmount: false, amountUnknown: doc.amount_incl_tax === null && doc.amount_excl_tax === null, warnings: [] };
  const fail = (reason: string) => {
    r.ok = false;
    r.reasons.push(reason);
  };
  if (doc.doc_type !== "QUOTE") fail(doc.doc_type === "CONTRACT" ? "Document contractuel détecté — traitement manuel requis" : `Seul un devis peut être signé par ce workflow (type : ${doc.doc_type ?? "non analysé"})`);
  if (doc.text_status !== "extracted") fail("Le PDF ne peut pas être signé automatiquement (texte non exploitable)");
  if (x?.injection_suspected) fail("Instructions suspectes détectées dans le document — traitement manuel requis");
  const company = companyId ? companies.find((c) => c.id === companyId) ?? null : null;
  if (!companyId) fail("Société non déterminée : aucune signature possible");
  else if (!company) fail(`Société inconnue : ${companyId}`);
  if (company) {
    r.company = company;
    const sig = assetStatus(company, "signature");
    if (!sig.configured) fail(`Signature non configurée pour la société ${company.name}`);
    else if (!sig.available) fail(`Fichier de signature introuvable pour la société ${company.name}`);
    else r.signatureLabel = assetLabel(company, "signature");
    const stamp = assetStatus(company, "stamp");
    if (stamp.configured && stamp.available) {
      r.stampApplied = true;
      r.stampLabel = assetLabel(company, "stamp");
    } else if (company.stampRequired) fail(`Tampon obligatoire non disponible pour la société ${company.name}`);
  }
  if (x?.valid_until) {
    const today = todayInTimezone(settings.company.timezone);
    if (x.valid_until < today) {
      r.quoteExpired = true;
      r.expiredSince = x.valid_until;
      r.warnings.push(`Le devis semble expiré depuis le ${formatDateOnly(x.valid_until, settings.company.timezone)}`);
    }
  } else if (x?.warnings.some((w) => w.startsWith(QUOTE_EXPIRED_WARNING))) r.quoteExpired = true;
  if (r.bankChange) r.warnings.push("Changement de coordonnées bancaires détecté — vérification humaine requise");
  if (r.amountUnknown) r.warnings.push("Montant non détecté — vérification recommandée");
  if (doc.amount_incl_tax !== null && doc.amount_incl_tax >= settings.signature.warningAmount) {
    r.highAmount = true;
    r.warnings.push(`Montant élevé (≥ ${formatAmount(settings.signature.warningAmount, doc.currency ?? "EUR")})`);
  }
  if (doc.possible_duplicate === 1) r.warnings.push("Doublon potentiel détecté");
  return r;
}

export interface PrepareResult {
  actionId: string | null;
  readiness: SignatureReadiness;
  reused: boolean;
}

/**
 * Prépare l'action CRITICAL `sign_document` (une seule validation couvre :
 * bon pour accord, date, signature, tampon, copie signée, retour au fournisseur).
 */
export function prepareQuoteSignature(documentId: string, companyId: string | null, deps: PrepareDeps = {}): PrepareResult {
  const db = deps.db ?? getDb();
  const settings = deps.settings ?? getSettings();
  const doc = documentsRepo.getDocument(documentId, db);
  if (!doc) throw new EmaError("NOT_FOUND", `Document ${documentId} introuvable`);
  const email = doc.email_id ? emailsRepo.getEmail(doc.email_id, db) : undefined;
  if (!email) throw new EmaError("VALIDATION", "Devis sans email source : retour au fournisseur impossible");
  const readiness = checkSignatureReadiness(doc, companyId ?? doc.company_id, { db, settings, companies: deps.companies });

  const existing = actionsRepo.listActionsForEmail(email.id, db).find((a) => a.type === "sign_document" && a.document_id === doc.id && (a.status === "WAITING_APPROVAL" || a.status === "PROPOSED" || a.status === "APPROVED" || a.status === "EXECUTING"));
  if (existing) return { actionId: existing.id, readiness, reused: true };
  if (doc.signed_document_id) return { actionId: null, readiness: { ...readiness, ok: false, reasons: ["Ce devis a déjà été signé"] }, reused: false };

  if (!readiness.ok || !readiness.company) {
    logHistory({ eventType: "signature.blocked", message: `Signature non proposée : ${readiness.reasons.join(" ; ")}`, actor: "ema", emailId: email.id, documentId: doc.id }, db);
    documentsRepo.updateDocument(doc.id, { requires_human_review: 1 }, db);
    return { actionId: null, readiness, reused: false };
  }
  const company = readiness.company;
  const x = readExtraction(doc);
  const supplier = doc.supplier_name ?? email.sender_name ?? email.sender_email ?? "fournisseur";
  const ref = doc.quote_number ?? x?.quote_number ?? null;
  const payload: ActionPayloadOutput<"sign_document"> = {
    email_id: email.id,
    document_id: doc.id,
    company_id: company.id,
    supplier_name: supplier,
    quote_number: ref,
    subject: doc.subject ?? x?.subject ?? null,
    amount_excl_tax: doc.amount_excl_tax,
    amount_incl_tax: doc.amount_incl_tax,
    currency: doc.currency ?? "EUR",
    valid_until: doc.valid_until,
    approval_text: company.quoteApprovalText,
    signature_required: true,
    stamp_required: readiness.stampApplied,
    signature_label: readiness.signatureLabel ?? company.name,
    stamp_label: readiness.stampLabel,
    signer_name: company.signatory.name || null,
    signer_title: company.signatory.title || null,
    placement_strategy: company.signaturePlacement.mode,
    return_to_original_sender: true,
    reply_to: email.sender_email,
    reply_subject: `${settings.signature.replySubjectPrefix} ${ref ?? doc.name}`.trim(),
    reply_body: `${settings.signature.replyTemplate}\n${settings.agent.signatureText}`.trim(),
    quote_expired: readiness.quoteExpired,
    warnings: readiness.warnings,
    mention: company.quoteApprovalText,
  };
  const amount = doc.amount_incl_tax !== null ? ` — ${formatAmount(doc.amount_incl_tax, doc.currency ?? "EUR")} TTC` : "";
  const action = proposeAction(
    { type: "sign_document", title: `Signer et retourner le devis ${supplier}${ref ? ` ${ref}` : ""}${amount} (${company.name})`, payload, sourceEmailId: email.id, companyId: company.id, documentId: doc.id, requiresApproval: true, actor: deps.actor ?? "ema" },
    { db, settings },
  );
  documentsRepo.updateDocument(doc.id, { status: "sign_proposed", signed_action_id: action.id }, db);
  logHistory({ eventType: "signature.proposed", message: `Signature proposée : ${company.quoteApprovalText}, date, ${readiness.signatureLabel}${readiness.stampApplied ? `, ${readiness.stampLabel}` : ""}, retour à ${email.sender_email ?? "?"}${readiness.warnings.length ? ` — ${readiness.warnings.join(" ; ")}` : ""}`, actor: deps.actor ?? "ema", actionId: action.id, emailId: email.id, documentId: doc.id, details: { company_id: company.id, placement: company.signaturePlacement.mode, stamp: readiness.stampApplied } }, db);
  return { actionId: action.id, readiness, reused: false };
}

/* Exécution (après validation uniquement) --------------------------------- */

export interface SignedArtifact {
  document: DocumentRow;
  reused: boolean;
}

/**
 * Crée la copie signée si elle n'existe pas encore pour cette action ; sinon la
 * réutilise (idempotence : un échec Graph ne produit jamais une seconde copie).
 */
export async function createSignedCopy(payload: ActionPayloadOutput<"sign_document">, actionId: string, deps: PrepareDeps = {}): Promise<SignedArtifact> {
  const db = deps.db ?? getDb();
  const settings = deps.settings ?? getSettings();
  const companies = deps.companies ?? getCompanies();
  const original = documentsRepo.getDocument(payload.document_id, db);
  if (!original) throw new EmaError("NOT_FOUND", `Document ${payload.document_id} introuvable`);
  if (original.signed_document_id) {
    const existing = documentsRepo.getDocument(original.signed_document_id, db);
    if (existing && fs.existsSync(safeJoin(privateRoot(), existing.original_path))) return { document: existing, reused: true };
  }
  const company = companies.find((c) => c.id === payload.company_id);
  if (!company) throw new EmaError("CONFIG", `Société inconnue : ${payload.company_id}`);
  const readiness = checkSignatureReadiness(original, company.id, { db, settings, companies });
  if (!readiness.ok) throw new EmaError("VALIDATION", readiness.reasons.join(" ; "));

  const signature = loadAsset(company, "signature");
  const stamp = readiness.stampApplied ? loadAsset(company, "stamp") : null;
  logHistory({ eventType: "signature.assets_selected", message: `Assets sélectionnés : ${signature.label}${stamp ? `, ${stamp.label}` : ""}`, actor: "ema", actionId, emailId: original.email_id, documentId: original.id }, db);

  const originalFile = safeJoin(privateRoot(), original.original_path);
  if (!fs.existsSync(originalFile)) throw new EmaError("NOT_FOUND", "Fichier original absent du stockage privé");
  const originalBytes = fs.readFileSync(originalFile);
  const originalHash = createHash("sha256").update(originalBytes).digest("hex");
  if (original.sha256 && original.sha256 !== originalHash) throw new EmaError("CONFLICT", "L'empreinte du document original ne correspond plus : signature refusée");

  const signedAt = nowIso();
  const dateText = formatDateOnly(signedAt, settings.company.timezone);
  const signedBytes = await buildSignedPdf({
    original: originalBytes,
    approvalText: payload.approval_text,
    dateText,
    companyName: company.legalName || company.name,
    signerName: payload.signer_name,
    signerTitle: payload.signer_title,
    signature: signature.bytes,
    stamp: stamp?.bytes ?? null,
    placement: company.signaturePlacement,
  });
  const dir = privatePath("signed-documents", signedAt.slice(0, 4), signedAt.slice(5, 7));
  ensureDir(dir);
  const base = sanitizeFilename(original.name.replace(/\.pdf$/i, ""), "devis");
  const storedName = `${original.id}-${base}-signed-${signedAt.slice(0, 10).replace(/-/g, "")}.pdf`;
  fs.writeFileSync(path.join(dir, storedName), signedBytes);
  const relative = `signed-documents/${signedAt.slice(0, 4)}/${signedAt.slice(5, 7)}/${storedName}`;
  const signedHash = createHash("sha256").update(signedBytes).digest("hex");
  const signed = documentsRepo.insertDocument(
    { parentDocumentId: original.id, emailId: original.email_id, attachmentId: null, name: `${base}-signe.pdf`, mimeType: "application/pdf", size: signedBytes.length, category: "signed", companyId: company.id, originalPath: relative, storedName, sha256: signedHash, status: "signed" },
    db,
  );
  const approval = getLatestApprovalForAction(actionId, db);
  documentsRepo.updateDocument(signed.id, { doc_type: "QUOTE", quote_number: original.quote_number, supplier_name: original.supplier_name, amount_incl_tax: original.amount_incl_tax, amount_excl_tax: original.amount_excl_tax, currency: original.currency, subject: original.subject, signed_at: signedAt, signed_action_id: actionId, signed_approval_id: approval?.id ?? null, text_status: "extracted", analyzed_at: signedAt }, db);
  documentsRepo.updateDocument(original.id, { signed_path: relative, signed_at: signedAt, signed_document_id: signed.id, signed_action_id: actionId, signed_approval_id: approval?.id ?? null, status: "signed" }, db);
  logHistory({ eventType: "document.signed", message: `Copie signée créée (${payload.approval_text}, ${dateText}, ${signature.label}${stamp ? `, ${stamp.label}` : ""}) — original inchangé`, actor: "ema", actionId, emailId: original.email_id, documentId: signed.id, approvalId: approval?.id ?? null, details: { original_document_id: original.id, original_sha256: originalHash, signed_sha256: signedHash, placement: company.signaturePlacement.mode } }, db);
  log.info("signed copy created", { documentId: original.id, signedId: signed.id });
  return { document: documentsRepo.getDocument(signed.id, db) as DocumentRow, reused: false };
}

export function markSignedDocumentSent(original: DocumentRow, signed: DocumentRow, sentEmailId: string | null, db: Db = getDb()): void {
  documentsRepo.updateDocument(original.id, { status: "signed_and_sent", sent_at: nowIso() }, db);
  documentsRepo.updateDocument(signed.id, { status: "sent", sent_at: nowIso() }, db);
  if (original.email_id) emailsRepo.updateEmailStatus(original.email_id, "PROCESSED", db);
  void sentEmailId;
}

export function emailForDocument(doc: DocumentRow, db: Db = getDb()): EmailRow | undefined {
  return doc.email_id ? emailsRepo.getEmail(doc.email_id, db) : undefined;
}
