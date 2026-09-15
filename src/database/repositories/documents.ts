import type { Db } from "../connection";
import { getDb } from "../connection";
import type { DocumentCategory, DocumentRow } from "../types";
import { newId, nowIso } from "@/lib/ids";

export interface NewDocument {
  emailId?: string | null;
  attachmentId?: string | null;
  name: string;
  mimeType: string;
  size: number;
  category?: DocumentCategory;
  companyId?: string | null;
  originalPath: string;
  status?: string;
}

export function insertDocument(input: NewDocument, db: Db = getDb()): DocumentRow {
  const id = newId("doc");
  db.prepare(
    `INSERT INTO documents (id, email_id, attachment_id, name, mime_type, size, category, company_id, original_path, status, created_at)
     VALUES (@id, @email_id, @attachment_id, @name, @mime_type, @size, @category, @company_id, @original_path, @status, @created_at)`,
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
    status: input.status ?? "received",
    created_at: nowIso(),
  });
  return getDocument(id, db) as DocumentRow;
}

export function getDocument(id: string, db: Db = getDb()): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
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

export function updateDocument(
  id: string,
  patch: Partial<Pick<DocumentRow, "category" | "company_id" | "signed_path" | "extracted_text" | "extracted_data" | "status" | "signed_at">>,
  db: Db = getDb(),
): void {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE documents SET ${sets} WHERE id = @id`).run({ id, ...Object.fromEntries(entries) });
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
