import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFImage } from "pdf-lib";
import type { SignaturePlacement } from "@/lib/config";
import { EmaError } from "@/lib/errors";

/**
 * Génération de la copie signée (pdf-lib). Fonction pure : entrée = octets de
 * l'original + assets déjà chargés ; sortie = nouveaux octets. L'original n'est
 * jamais modifié. Un PDF chiffré ou illisible lève une erreur : jamais contourné.
 */
export interface SignPdfInput {
  original: Buffer;
  approvalText: string; // ex. « Bon pour accord »
  dateText: string; // générée par le serveur, fuseau du client
  companyName: string;
  signerName: string | null;
  signerTitle: string | null;
  signature: Buffer | null;
  stamp: Buffer | null;
  placement: SignaturePlacement;
}

const MARGIN = 50;

export async function buildSignedPdf(input: SignPdfInput): Promise<Buffer> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(input.original, { ignoreEncryption: false, updateMetadata: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const encrypted = /encrypt/i.test(message);
    throw new EmaError("VALIDATION", encrypted ? "Le PDF est protégé : il ne peut pas être signé automatiquement" : `Le PDF ne peut pas être chargé : ${message.slice(0, 120)}`, { cause: err });
  }
  if (doc.isEncrypted) throw new EmaError("VALIDATION", "Le PDF est protégé : il ne peut pas être signé automatiquement");
  let pageCount = 0;
  try {
    pageCount = doc.getPageCount();
  } catch (err) {
    throw new EmaError("VALIDATION", "Le PDF est corrompu : structure de pages illisible", { cause: err });
  }
  if (pageCount === 0) throw new EmaError("VALIDATION", "Le PDF ne contient aucune page");

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const signature = input.signature ? await embedPng(doc, input.signature, "signature") : null;
  const stamp = input.stamp ? await embedPng(doc, input.stamp, "tampon") : null;
  const safe = (t: string) => t.replace(/[^\x20-\x7E -ÿ€]/g, "?");

  if (input.placement.mode === "OVERLAY_LAST_PAGE") {
    const page = doc.getPages()[doc.getPageCount() - 1] as PDFPage;
    const p = input.placement;
    page.drawText(safe(input.approvalText), { x: p.approvalText.x, y: p.approvalText.y, size: 11, font: bold, color: rgb(0, 0, 0) });
    page.drawText(safe(`Le ${input.dateText}`), { x: p.date.x, y: p.date.y, size: 10, font, color: rgb(0, 0, 0) });
    if (signature) drawFitted(page, signature, p.signature.x, p.signature.y, p.signature.width ?? 160, p.signature.height ?? 60);
    if (stamp && p.stamp) drawFitted(page, stamp, p.stamp.x, p.stamp.y, p.stamp.width ?? 110, p.stamp.height ?? 110);
  } else {
    const [w, h] = [595.28, 841.89];
    const page = doc.addPage([w, h]);
    let y = h - MARGIN - 20;
    page.drawText(safe(input.approvalText.toUpperCase()), { x: MARGIN, y, size: 18, font: bold });
    y -= 40;
    const line = (label: string, value: string) => {
      page.drawText(safe(`${label} :`), { x: MARGIN, y, size: 11, font: bold });
      page.drawText(safe(value), { x: MARGIN + 110, y, size: 11, font });
      y -= 22;
    };
    line("Société", input.companyName);
    line("Date", input.dateText);
    if (input.signerName) line("Signataire", input.signerTitle ? `${input.signerName}, ${input.signerTitle}` : input.signerName);
    y -= 20;
    if (signature) {
      page.drawText(safe("Signature :"), { x: MARGIN, y, size: 11, font: bold });
      const hgt = 80;
      drawFitted(page, signature, MARGIN, y - hgt - 10, 220, hgt);
      y -= hgt + 40;
    }
    if (stamp) {
      page.drawText(safe("Tampon :"), { x: MARGIN, y, size: 11, font: bold });
      const hgt = 120;
      drawFitted(page, stamp, MARGIN, y - hgt - 10, 160, hgt);
      y -= hgt + 40;
    }
    page.drawText(safe("Page d'approbation ajoutée par EMA - document original inchangé."), { x: MARGIN, y: MARGIN, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
  }
  return Buffer.from(await doc.save());
}

async function embedPng(doc: PDFDocument, bytes: Buffer, label: string): Promise<PDFImage> {
  try {
    return await doc.embedPng(bytes);
  } catch (err) {
    throw new EmaError("VALIDATION", `Image de ${label} illisible (PNG attendu)`, { cause: err });
  }
}

/** Dessine l'image dans une boîte en conservant les proportions. */
function drawFitted(page: PDFPage, image: PDFImage, x: number, y: number, maxW: number, maxH: number): void {
  const ratio = Math.min(maxW / image.width, maxH / image.height, 1e9);
  const w = image.width * ratio;
  const h = image.height * ratio;
  page.drawImage(image, { x, y, width: w, height: h });
}
