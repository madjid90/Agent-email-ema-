import type { Db } from "../connection";
import { getDb } from "../connection";
import type { DocumentCategory, DocumentRow } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewDocument {
  parentDocumentId?: string | null;
  emailId?: string | null;
  attachmentId?: string | null;
  name: string;
  mimeType: string;
  size: number;
  category?: DocumentCategory;
  companyId?: string | null;
  originalPath: string;
  storedName?: string | null;
  sha256?: string | null;
  status?: string;
}

export function insertDocument(input: NewDocument, db: Db = getDb()): DocumentRow {
  const id = newId("doc");
  db.prepare(
    `INSERT INTO documents (id, email_id, attachment_id, name, mime_type, size, category, company_id, original_path, stored_name, sha256, status, created_at, parent_document_id)
     VALUES (@id, @email_id, @attachment_id, @name, @mime_type, @size, @category, @company_id, @original_path, @stored_name, @sha256, @status, @created_at, @parent_document_id)`,
  ).run({
    id,
    email_id: input.emailId ?? null,
    attachment_id: input.attachmentId ?? null,
    name: input.name,
    mime_type: input.mimeType,
    size: input.size,
    category: input.category ?? "other",
    company_id: input.companyId ?? null,
    original_path: input.originalPath,
    stored_name: input.storedName ?? null,
    sha256: input.sha256 ?? null,
    status: input.status ?? "received",
    created_at: nowIso(),
    parent_document_id: input.parentDocumentId ?? null,
  });
  return getDocument(id, db) as DocumentRow;
}

export function getDocument(id: string, db: Db = getDb()): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
}

export function getDocumentByAttachment(emailId: string, attachmentId: string, db: Db = getDb()): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE email_id = ? AND attachment_id = ?").get(emailId, attachmentId) as DocumentRow | undefined;
}

export function listDocuments(opts: { category?: DocumentCategory; emailId?: string; limit?: number } = {}, db: Db = getDb()): DocumentRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 200 };
  if (opts.category) {
    clauses.push("category = @category");
    params.category = opts.category;
  }
  if (opts.emailId) {
    clauses.push("email_id = @email_id");
    params.email_id = opts.emailId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM documents ${where} ORDER BY created_at DESC LIMIT @limit`).all(params) as DocumentRow[];
}

export type DocumentPatch = Partial<
  Pick<
    DocumentRow,
    | "category" | "company_id" | "signed_path" | "extracted_text" | "extracted_data" | "status" | "signed_at"
    | "doc_type" | "text_status" | "text_pages" | "supplier_name" | "invoice_number" | "invoice_date" | "due_date"
    | "amount_excl_tax" | "amount_incl_tax" | "currency" | "doc_confidence" | "requires_human_review" | "possible_duplicate"
    | "duplicate_of" | "bank_details_change" | "analyzed_at" | "analysis_error"
    | "quote_number" | "valid_until" | "subject" | "parent_document_id" | "signed_document_id" | "signed_action_id" | "signed_approval_id" | "sent_at"
  >
>;

export function updateDocument(id: string, patch: DocumentPatch, db: Db = getDb()): void {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE documents SET ${sets} WHERE id = @id`).run({ id, ...Object.fromEntries(entries) });
}

export interface DocumentSearch {
  docType?: string | string[];
  category?: DocumentCategory;
  supplier?: string;
  invoiceNumber?: string;
  query?: string;
  since?: string;
  requiresReview?: boolean;
  possibleDuplicate?: boolean;
  limit?: number;
}

export function searchDocuments(opts: DocumentSearch = {}, db: Db = getDb()): DocumentRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 100 };
  if (opts.docType) {
    const types = Array.isArray(opts.docType) ? opts.docType : [opts.docType];
    clauses.push(`doc_type IN (${types.map((_, i) => `@t${i}`).join(",")})`);
    types.forEach((t, i) => (params[`t${i}`] = t));
  }
  if (opts.category) {
    clauses.push("category = @category");
    params.category = opts.category;
  }
  if (opts.supplier) {
    clauses.push("lower(supplier_name) LIKE @supplier");
    params.supplier = `%${opts.supplier.toLowerCase()}%`;
  }
  if (opts.invoiceNumber) {
    clauses.push("lower(invoice_number) LIKE @inv");
    params.inv = `%${opts.invoiceNumber.toLowerCase()}%`;
  }
  if (opts.query) {
    clauses.push("(lower(name) LIKE @q OR lower(supplier_name) LIKE @q OR lower(invoice_number) LIKE @q OR lower(quote_number) LIKE @q OR lower(subject) LIKE @q)");
    params.q = `%${opts.query.toLowerCase()}%`;
  }
  if (opts.since) {
    clauses.push("created_at >= @since");
    params.since = opts.since;
  }
  if (opts.requiresReview !== undefined) clauses.push(`requires_human_review = ${opts.requiresReview ? 1 : 0}`);
  if (opts.possibleDuplicate !== undefined) clauses.push(`possible_duplicate = ${opts.possibleDuplicate ? 1 : 0}`);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM documents ${where} ORDER BY created_at DESC LIMIT @limit`).all(params) as DocumentRow[];
}

/** Candidats doublons : même empreinte, ou même fournisseur + numéro, ou même fournisseur + montant TTC. */
export function findDuplicateCandidates(doc: Pick<DocumentRow, "id" | "sha256" | "supplier_name" | "invoice_number" | "amount_incl_tax" | "company_id">, db: Db = getDb()): DocumentRow[] {
  return db
    .prepare(
      `SELECT * FROM documents WHERE id != @id AND (
         (@sha IS NOT NULL AND sha256 = @sha)
         OR (@supplier IS NOT NULL AND @inv IS NOT NULL AND lower(supplier_name) = lower(@supplier) AND lower(invoice_number) = lower(@inv))
         OR (@supplier IS NOT NULL AND @amount IS NOT NULL AND lower(supplier_name) = lower(@supplier) AND amount_incl_tax = @amount)
       ) ORDER BY created_at DESC LIMIT 10`,
    )
    .all({ id: doc.id, sha: doc.sha256, supplier: doc.supplier_name, inv: doc.invoice_number, amount: doc.amount_incl_tax }) as DocumentRow[];
}

/** Documents PDF jamais analysés (rattrapage worker). */
export function listDocumentsPendingAnalysis(limit = 5, db: Db = getDb()): DocumentRow[] {
  return db
    .prepare("SELECT * FROM documents WHERE analyzed_at IS NULL AND analysis_error IS NULL AND mime_type = 'application/pdf' ORDER BY created_at ASC LIMIT ?")
    .all(limit) as DocumentRow[];
}

export interface DocumentStats {
  invoices: number;
  paymentProofs: number;
  toReview: number;
  duplicates: number;
  bankChanges: number;
}

export function documentStats(since: string, db: Db = getDb()): DocumentStats {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN doc_type IN ('INVOICE','CREDIT_NOTE') THEN 1 ELSE 0 END) AS invoices,
         SUM(CASE WHEN doc_type = 'PAYMENT_PROOF' THEN 1 ELSE 0 END) AS proofs,
         SUM(CASE WHEN requires_human_review = 1 THEN 1 ELSE 0 END) AS review,
         SUM(CASE WHEN possible_duplicate = 1 THEN 1 ELSE 0 END) AS dups,
         SUM(CASE WHEN bank_details_change = 1 THEN 1 ELSE 0 END) AS bank
       FROM documents WHERE created_at >= ?`,
    )
    .get(since) as Record<string, number | null>;
  return { invoices: row.invoices ?? 0, paymentProofs: row.proofs ?? 0, toReview: row.review ?? 0, duplicates: row.dups ?? 0, bankChanges: row.bank ?? 0 };
}

export function countDocuments(opts: { category?: DocumentCategory; since?: string } = {}, db: Db = getDb()): number {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.category) {
    clauses.push("category = @category");
    params.category = opts.category;
  }
  if (opts.since) {
    clauses.push("created_at >= @since");
    params.since = opts.since;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return (db.prepare(`SELECT COUNT(*) AS n FROM documents ${where}`).get(params) as { n: number }).n;
}
