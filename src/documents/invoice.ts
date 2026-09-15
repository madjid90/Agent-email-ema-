import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as documentsRepo from "@/database/repositories/documents";
import type { DocumentRow } from "@/database/types";
import type { Company } from "@/lib/config";
import type { ClassificationHint } from "./classify";
import type { DocumentExtraction, DuplicateMatch } from "./types";

/** Tolérance de cohérence HT + TVA = TTC : 2 centimes ou 1 %. */
const AMOUNT_TOLERANCE_ABS = 0.02;
const AMOUNT_TOLERANCE_REL = 0.01;

export interface GuardInput {
  companies: Company[];
  hint: ClassificationHint;
  heuristicInjection: boolean;
  reviewThreshold: number;
  /** Date du jour (YYYY-MM-DD, fuseau du client) pour l'expiration des devis. */
  today?: string;
}

export const QUOTE_EXPIRED_WARNING = "QUOTE_EXPIRED";

/**
 * Validations déterministes appliquées après l'extraction Claude (jamais de
 * reconstruction d'un montant absent, jamais de société hors configuration).
 */
export function applyDocumentGuards(raw: DocumentExtraction, input: GuardInput): DocumentExtraction {
  const d: DocumentExtraction = { ...raw, warnings: [...raw.warnings] };
  const warn = (w: string) => {
    if (!d.warnings.includes(w)) d.warnings.push(w);
    d.requires_human_review = true;
  };

  for (const key of ["amount_excl_tax", "vat_amount", "amount_incl_tax", "deposit_amount", "total_amount"] as const) {
    const v = d[key];
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      d[key] = null;
      warn(`Montant invalide ignoré (${key})`);
    }
  }
  if (d.deposit_percent !== null && (d.deposit_percent <= 0 || d.deposit_percent > 100)) {
    d.deposit_percent = null;
    warn("Pourcentage d'acompte invalide ignoré");
  }
  if (d.amount_excl_tax !== null && d.vat_amount !== null && d.amount_incl_tax !== null) {
    const expected = d.amount_excl_tax + d.vat_amount;
    const delta = Math.abs(expected - d.amount_incl_tax);
    if (delta > Math.max(AMOUNT_TOLERANCE_ABS, AMOUNT_TOLERANCE_REL * Math.abs(d.amount_incl_tax))) warn(`Montants incohérents : HT ${d.amount_excl_tax} + TVA ${d.vat_amount} ≠ TTC ${d.amount_incl_tax}`);
  }
  if (d.amount_incl_tax !== null && d.amount_excl_tax !== null && d.amount_incl_tax < d.amount_excl_tax) warn("Montant TTC inférieur au montant HT");
  const anyAmount = d.amount_incl_tax !== null || d.amount_excl_tax !== null || d.deposit_amount !== null || d.total_amount !== null;
  if (anyAmount && !d.currency) d.currency = "EUR";
  if (!anyAmount) d.currency = null;

  if (d.company_id && !input.companies.some((c) => c.id === d.company_id)) {
    d.company_id = null;
    warn("Société extraite absente de la configuration");
  }
  if (!d.company_id && d.customer_company_name) {
    const needle = d.customer_company_name.toLowerCase();
    const matches = input.companies.filter((c) => [c.name, ...c.aliases].some((n) => n && (needle.includes(n.toLowerCase()) || n.toLowerCase().includes(needle))));
    if (matches.length === 1) d.company_id = matches[0]!.id;
    else if (matches.length > 1) warn("Plusieurs sociétés plausibles : rattachement manuel nécessaire");
  }

  if (input.hint.ibanPresent) {
    d.iban_present = true;
    if (!d.iban_last4) d.iban_last4 = input.hint.ibanLast4;
  }
  if (input.hint.bankChangeSuspected || d.bank_details_change_suspected) {
    d.bank_details_change_suspected = true;
    warn("Changement de coordonnées bancaires détecté — vérification humaine requise");
  }
  if (d.document_type === "BANK_DETAILS") warn("Document de coordonnées bancaires : aucune action financière automatique");
  if (d.document_type === "PAYMENT_PROOF") d.warnings.push("Document présenté comme justificatif de paiement : ne vaut pas confirmation de règlement");

  if ((d.document_type === "INVOICE" || d.document_type === "CREDIT_NOTE") && d.amount_incl_tax === null && d.amount_excl_tax === null) warn("Aucun montant lisible");
  if ((d.document_type === "INVOICE" || d.document_type === "CREDIT_NOTE") && !d.invoice_number) warn("Numéro de facture absent");
  if (d.document_type === "QUOTE") {
    if (!d.quote_number && d.invoice_number) {
      d.quote_number = d.invoice_number;
      d.invoice_number = null;
    }
    if (d.amount_incl_tax === null && d.amount_excl_tax === null) warn("Aucun montant lisible sur le devis");
    if (d.valid_until && input.today && d.valid_until < input.today) warn(`${QUOTE_EXPIRED_WARNING} : devis potentiellement expiré depuis le ${d.valid_until}`);
  }
  if (d.document_type === "CONTRACT") warn("Document contractuel détecté — traitement manuel requis");
  if (d.document_confidence < input.reviewThreshold) d.requires_human_review = true;
  if (input.heuristicInjection || d.injection_suspected) {
    d.injection_suspected = true;
    warn("Instructions adressées à l'assistant détectées dans le document");
  }
  return d;
}

/** Doublons potentiels : jamais un seul critère faible, jamais de suppression. */
export function detectDuplicates(doc: DocumentRow, d: DocumentExtraction, db: Db = getDb()): DuplicateMatch[] {
  const candidates = documentsRepo.findDuplicateCandidates({ id: doc.id, sha256: doc.sha256, supplier_name: d.supplier_name, invoice_number: d.invoice_number, amount_incl_tax: d.amount_incl_tax, company_id: d.company_id }, db);
  const matches: DuplicateMatch[] = [];
  for (const c of candidates) {
    const reasons: string[] = [];
    const sameFile = Boolean(doc.sha256 && c.sha256 === doc.sha256);
    const sameSupplier = Boolean(d.supplier_name && c.supplier_name && c.supplier_name.toLowerCase() === d.supplier_name.toLowerCase());
    const sameNumber = sameSupplier && Boolean(d.invoice_number && c.invoice_number && c.invoice_number.toLowerCase() === d.invoice_number.toLowerCase());
    const sameAmount = sameSupplier && d.amount_incl_tax !== null && c.amount_incl_tax === d.amount_incl_tax;
    const sameDate = Boolean(d.invoice_date && c.invoice_date === d.invoice_date);
    const sameCompany = Boolean(d.company_id && c.company_id === d.company_id);
    if (sameFile) reasons.push("fichier identique (même empreinte)");
    if (sameNumber) reasons.push("même fournisseur et même numéro");
    if (sameAmount) reasons.push("même fournisseur et même montant TTC");
    if (sameAmount && sameDate) reasons.push("même date de facture");
    if (sameCompany && reasons.length) reasons.push("même société");
    // Critère fort (empreinte, ou fournisseur + numéro), ou fournisseur + montant + date concordants.
    // Fournisseur + montant seuls (facture récurrente) ne suffisent jamais.
    if (sameFile || sameNumber || (sameAmount && sameDate)) matches.push({ document_id: c.id, name: c.name, reasons, created_at: c.created_at });
  }
  return matches;
}
