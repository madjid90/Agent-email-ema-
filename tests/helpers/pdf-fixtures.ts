import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Db } from "@/database/connection";
import * as emails from "@/database/repositories/emails";
import * as documents from "@/database/repositories/documents";
import { privateRoot, ensureDir } from "@/lib/paths";
import { createHash } from "node:crypto";

/** PDF texte (police standard : texte extractible par pdf.js). */
export async function makeTextPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 790;
  for (const line of lines) {
    page.drawText(line.replace(/[^\x20-\x7E -ÿ]/g, "?"), { x: 50, y, size: 11, font });
    y -= 18;
  }
  return Buffer.from(await doc.save());
}

/** PDF sans texte (page vide : équivalent d'un scan). */
export async function makeBlankPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

export const INVOICE_LINES = [
  "ABC Services SAS",
  "12 rue des Fournisseurs, 69000 Lyon",
  "compta@abc-services.fr",
  "",
  "FACTURE N° F2026-1245",
  "Date : 15/09/2026",
  "Client : Alpha SAS",
  "",
  "Prestation de maintenance septembre",
  "Montant HT : 1 537,67 EUR",
  "TVA 20 % : 307,53 EUR",
  "Montant TTC : 1 845,20 EUR",
  "",
  "Echeance : 30/09/2026",
  "IBAN : FR76 3000 6000 0112 3456 7890 189",
];

export interface SeededDoc {
  emailId: string;
  documentId: string;
}

/** Insère un email + un document PDF réel dans private/documents (chemin relatif conforme). */
export async function seedPdfDocument(db: Db, bytes: Buffer, opts: { name?: string; subject?: string; body?: string; sender?: string; graphId?: string; mime?: string; status?: "NEW" | "ANALYZED" } = {}): Promise<SeededDoc> {
  const email = emails.insertEmail({
    graphId: opts.graphId ?? `g-${Math.random().toString(36).slice(2)}`,
    threadId: "t-doc",
    senderName: "Compta ABC",
    senderEmail: opts.sender ?? "compta@abc-services.fr",
    subject: opts.subject ?? "Votre facture",
    bodyText: opts.body ?? "Bonjour, veuillez trouver notre facture en pièce jointe.",
    receivedAt: "2026-09-15T10:00:00.000Z",
    hasAttachments: true,
    status: opts.status ?? "NEW",
  }, db);
  const dir = path.join(privateRoot(), "documents", "2026", "09");
  ensureDir(dir);
  const storedName = `${email.id}-${opts.name ?? "facture.pdf"}`;
  fs.writeFileSync(path.join(dir, storedName), bytes);
  const doc = documents.insertDocument({
    emailId: email.id,
    attachmentId: `att-${email.id}`,
    name: opts.name ?? "facture.pdf",
    mimeType: opts.mime ?? "application/pdf",
    size: bytes.length,
    originalPath: `documents/2026/09/${storedName}`,
    storedName,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, db);
  return { emailId: email.id, documentId: doc.id };
}
