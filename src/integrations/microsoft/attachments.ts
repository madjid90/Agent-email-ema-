import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as documentsRepo from "@/database/repositories/documents";
import { logHistory } from "@/database/repositories/history";
import type { DocumentRow, EmailRow } from "@/database/types";
import { EmaError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { createLogger } from "@/lib/logger";
import { ensureDir, privatePath, sanitizeFilename } from "@/lib/paths";
import { isActiveContent } from "@/lib/content-safety";
import type { GraphClient } from "./graph-client";
import type { GraphAttachment } from "./types";

const log = createLogger("microsoft.attachments");

export interface AttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  isFile: boolean;
}

/** Extensions refusées : jamais téléchargées, jamais exécutées. */
export const DANGEROUS_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "cpl", "dll", "sys", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "psm1", "hta", "jar", "lnk", "reg", "sh", "bash", "app", "dmg", "apk", "iso", "img", "vhd",
]);

const DANGEROUS_MIME = /(x-msdownload|x-msdos-program|x-executable|x-sh|javascript|x-java-archive|hta)/i;

export function isDangerousAttachment(name: string, contentType: string): boolean {
  const parts = name.toLowerCase().split(".");
  // Double extension (facture.pdf.exe) : la dernière fait foi, mais on refuse aussi toute extension dangereuse intermédiaire.
  if (parts.length > 1 && parts.slice(1).some((ext) => DANGEROUS_EXTENSIONS.has(ext))) return true;
  return DANGEROUS_MIME.test(contentType);
}

/**
 * Pièce jointe au contenu actif (HTML, SVG, XML…) : elle est archivée — elle peut
 * servir de preuve — mais jamais affichée dans l'origine EMA (voir
 * `src/lib/content-safety.ts`) et jamais analysée comme un document.
 */
export function isActiveAttachment(name: string, contentType: string): boolean {
  return isActiveContent(name, contentType);
}

export function toMeta(a: GraphAttachment): AttachmentMeta {
  return {
    id: a.id,
    name: a.name ?? "piece-jointe",
    contentType: a.contentType ?? "application/octet-stream",
    size: a.size ?? 0,
    isInline: Boolean(a.isInline),
    isFile: (a["@odata.type"] ?? "").endsWith("fileAttachment"),
  };
}

export async function listAttachments(client: GraphClient, messageId: string): Promise<AttachmentMeta[]> {
  const items = await client.getAll<GraphAttachment>(`/me/messages/${encodeURIComponent(messageId)}/attachments`, { $select: "id,name,contentType,size,isInline" }, { limit: 50 });
  return items.map(toMeta);
}

export async function downloadAttachment(client: GraphClient, messageId: string, attachmentId: string): Promise<Buffer> {
  return client.getBinary(`/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`);
}

export interface StoreInput {
  email: EmailRow;
  meta: AttachmentMeta;
  bytes: Buffer;
  maxBytes: number;
}

/** Vérifie, écrit dans private/documents/yyyy/mm/ et enregistre le document. */
export function storeAttachment(input: StoreInput, db: Db = getDb()): DocumentRow {
  const { email, meta, bytes } = input;
  if (isDangerousAttachment(meta.name, meta.contentType)) throw new EmaError("FORBIDDEN", `Pièce jointe refusée (type dangereux) : ${meta.name}`);
  if (bytes.length > input.maxBytes) throw new EmaError("VALIDATION", `Pièce jointe trop volumineuse : ${meta.name} (${Math.round(bytes.length / 1024)} Ko)`);
  const existing = documentsRepo.getDocumentByAttachment(email.id, meta.id, db);
  if (existing) return existing;

  const docId = newId("doc");
  const received = new Date(email.received_at);
  const yyyy = String(received.getUTCFullYear());
  const mm = String(received.getUTCMonth() + 1).padStart(2, "0");
  const storedName = `${docId}-${sanitizeFilename(meta.name)}`;
  const dir = privatePath("documents", yyyy, mm);
  ensureDir(dir);
  const absolute = path.join(dir, storedName);
  fs.writeFileSync(absolute, bytes);
  const relative = `documents/${yyyy}/${mm}/${storedName}`;
  const doc = documentsRepo.insertDocument(
    {
      emailId: email.id,
      attachmentId: meta.id,
      name: meta.name,
      mimeType: meta.contentType,
      size: bytes.length,
      originalPath: relative,
      storedName,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      status: "received",
    },
    db,
  );
  logHistory({ eventType: "document.received", message: `Pièce jointe archivée : ${meta.name}`, actor: "worker", emailId: email.id, documentId: doc.id }, db);
  return doc;
}

export interface IngestResult {
  stored: DocumentRow[];
  skipped: { name: string; reason: string }[];
}

/** Télécharge et archive toutes les pièces jointes fichier (hors images inline) d'un email. */
export async function ingestEmailAttachments(client: GraphClient, email: EmailRow, maxBytes: number, db: Db = getDb()): Promise<IngestResult> {
  const result: IngestResult = { stored: [], skipped: [] };
  const metas = await listAttachments(client, email.graph_id);
  for (const meta of metas) {
    if (!meta.isFile || meta.isInline) {
      result.skipped.push({ name: meta.name, reason: meta.isInline ? "inline" : "non-file" });
      continue;
    }
    if (isDangerousAttachment(meta.name, meta.contentType)) {
      result.skipped.push({ name: meta.name, reason: "dangerous" });
      logHistory({ eventType: "document.refused", message: `Pièce jointe refusée (type dangereux) : ${meta.name}`, actor: "worker", emailId: email.id }, db);
      continue;
    }
    if (meta.size > maxBytes) {
      result.skipped.push({ name: meta.name, reason: "too-large" });
      logHistory({ eventType: "document.refused", message: `Pièce jointe ignorée (trop volumineuse) : ${meta.name}`, actor: "worker", emailId: email.id }, db);
      continue;
    }
    if (documentsRepo.getDocumentByAttachment(email.id, meta.id, db)) {
      result.skipped.push({ name: meta.name, reason: "exists" });
      continue;
    }
    try {
      const bytes = await downloadAttachment(client, email.graph_id, meta.id);
      result.stored.push(storeAttachment({ email, meta, bytes, maxBytes }, db));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.skipped.push({ name: meta.name, reason: message });
      log.warn("attachment ingest failed", { emailId: email.id, name: meta.name, message });
    }
  }
  return result;
}

/** Récupère (ou télécharge à la demande) une pièce jointe précise. */
export async function fetchAttachmentDocument(client: GraphClient, email: EmailRow, attachmentId: string, maxBytes: number, db: Db = getDb()): Promise<DocumentRow> {
  const existing = documentsRepo.getDocumentByAttachment(email.id, attachmentId, db);
  if (existing) return existing;
  const metas = await listAttachments(client, email.graph_id);
  const meta = metas.find((m) => m.id === attachmentId);
  if (!meta) throw new EmaError("NOT_FOUND", `Pièce jointe ${attachmentId} introuvable`);
  if (!meta.isFile) throw new EmaError("VALIDATION", `Pièce jointe non téléchargeable (${meta.name})`);
  if (isDangerousAttachment(meta.name, meta.contentType)) throw new EmaError("FORBIDDEN", `Pièce jointe refusée (type dangereux) : ${meta.name}`);
  if (meta.size > maxBytes) throw new EmaError("VALIDATION", `Pièce jointe trop volumineuse : ${meta.name}`);
  const bytes = await downloadAttachment(client, email.graph_id, attachmentId);
  return storeAttachment({ email, meta, bytes, maxBytes }, db);
}
