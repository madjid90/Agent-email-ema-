import fs from "node:fs";
import { PDFParse } from "pdf-parse";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as documentsRepo from "@/database/repositories/documents";
import { logHistory } from "@/database/repositories/history";
import type { DocumentRow } from "@/database/types";
import { getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { privateRoot, safeJoin } from "@/lib/paths";
import type { TextExtractionResult } from "./types";

const log = createLogger("documents.text");

/** Texte conservé en base (au-delà : tronqué, jamais réextrait plusieurs fois). */
export const MAX_STORED_TEXT_CHARS = 60_000;
/** En dessous, un PDF est considéré sans texte exploitable (scan) : OCR à prévoir, rien n'est inventé. */
export const MIN_USEFUL_TEXT_CHARS = 40;
export const SUPPORTED_TEXT_MIME = new Set(["application/pdf"]);
const PDF_MAGIC = Buffer.from("%PDF-");

/** Extraction du texte d'un PDF (pdf.js via pdf-parse). Aucun script du PDF n'est exécuté. */
export async function extractPdfText(bytes: Buffer): Promise<TextExtractionResult> {
  if (bytes.subarray(0, 5).compare(PDF_MAGIC) !== 0) throw new EmaError("VALIDATION", "Le fichier n'est pas un PDF");
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    const raw = (result.text ?? "").replace(/\n-- \d+ of \d+ --\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const truncated = raw.length > MAX_STORED_TEXT_CHARS;
    const text = truncated ? raw.slice(0, MAX_STORED_TEXT_CHARS) : raw;
    return { text, pages: result.total ?? 0, hasText: text.replace(/\s+/g, "").length >= MIN_USEFUL_TEXT_CHARS, truncated };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * Extrait (une seule fois) le texte d'un document archivé : MIME et taille
 * vérifiés, résultat conservé dans `documents.extracted_text` / `text_status`.
 */
export async function ensureDocumentText(doc: DocumentRow, db: Db = getDb()): Promise<DocumentRow> {
  if (doc.text_status !== "pending") return doc;
  const maxBytes = Math.round(getEnv().ATTACHMENT_MAX_MB * 1024 * 1024);
  const fail = (status: DocumentRow["text_status"], message: string): DocumentRow => {
    documentsRepo.updateDocument(doc.id, { text_status: status, analysis_error: status === "error" ? message : null }, db);
    logHistory({ eventType: status === "no_text" ? "document.no_text" : "document.text_unsupported", message, actor: "worker", documentId: doc.id, emailId: doc.email_id }, db);
    return documentsRepo.getDocument(doc.id, db) as DocumentRow;
  };
  if (!SUPPORTED_TEXT_MIME.has(doc.mime_type)) return fail("unsupported", `Type non pris en charge pour l'extraction de texte : ${doc.mime_type}`);
  if (doc.size > maxBytes) return fail("unsupported", `Document trop volumineux pour l'extraction (${Math.round(doc.size / 1024)} Ko)`);
  const file = safeJoin(privateRoot(), doc.original_path);
  if (!fs.existsSync(file)) return fail("error", "Fichier absent du stockage privé");
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length > maxBytes) return fail("unsupported", "Document trop volumineux pour l'extraction");
    const r = await extractPdfText(bytes);
    if (!r.hasText) {
      documentsRepo.updateDocument(doc.id, { text_status: "no_text", text_pages: r.pages, extracted_text: null, requires_human_review: 1 }, db);
      logHistory({ eventType: "document.no_text", message: `Aucun texte exploitable dans ${doc.name} (PDF scanné ?) : vérification humaine requise`, actor: "worker", documentId: doc.id, emailId: doc.email_id }, db);
      return documentsRepo.getDocument(doc.id, db) as DocumentRow;
    }
    documentsRepo.updateDocument(doc.id, { text_status: "extracted", text_pages: r.pages, extracted_text: r.text }, db);
    logHistory({ eventType: "document.text_extracted", message: `Texte extrait de ${doc.name} (${r.pages} page(s), ${r.text.length} caractères${r.truncated ? ", tronqué" : ""})`, actor: "worker", documentId: doc.id, emailId: doc.email_id }, db);
    return documentsRepo.getDocument(doc.id, db) as DocumentRow;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur d'extraction";
    log.warn("text extraction failed", { documentId: doc.id, message });
    return fail("error", `Extraction impossible : ${message.slice(0, 200)}`);
  }
}
