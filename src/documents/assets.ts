import fs from "node:fs";
import type { Company } from "@/lib/config";
import { EmaError } from "@/lib/errors";
import { privateRoot, safeJoin } from "@/lib/paths";

/**
 * Chargement et vérification des assets de signature / tampon (PNG uniquement).
 * Ces octets ne quittent jamais le backend : jamais dans un prompt, un payload,
 * une réponse API, un log ou l'historique.
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MIN_DIM = 20;
const MAX_DIM = 4000;

export interface LoadedAsset {
  bytes: Buffer;
  width: number;
  height: number;
  /** Nom logique affichable (jamais le chemin complet). */
  label: string;
}

export type AssetKind = "signature" | "stamp";

export function assetLabel(company: Company, kind: AssetKind): string {
  return kind === "signature" ? `Signature ${company.signatory.name || company.name}` : `Tampon ${company.name}`;
}

/** Disponibilité sans charger le fichier (pour l'interface et la proposition d'action). */
export function assetStatus(company: Company, kind: AssetKind): { configured: boolean; available: boolean } {
  const rel = kind === "signature" ? company.signaturePath : company.stampPath;
  if (!rel) return { configured: false, available: false };
  try {
    const file = safeJoin(privateRoot(), rel);
    return { configured: true, available: fs.existsSync(file) && fs.statSync(file).size > 0 };
  } catch {
    return { configured: true, available: false };
  }
}

export function loadAsset(company: Company, kind: AssetKind): LoadedAsset {
  const rel = kind === "signature" ? company.signaturePath : company.stampPath;
  if (!rel) throw new EmaError("CONFIG", `${kind === "signature" ? "Signature" : "Tampon"} non configuré pour la société ${company.name}`);
  if (!/^(signatures|stamps)\/[\w.\-]+\.png$/i.test(rel)) throw new EmaError("CONFIG", `Chemin d'asset invalide pour ${company.name}`);
  const file = safeJoin(privateRoot(), rel);
  if (!fs.existsSync(file)) throw new EmaError("CONFIG", `Fichier ${kind === "signature" ? "de signature" : "de tampon"} introuvable pour ${company.name}`);
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) throw new EmaError("VALIDATION", `Fichier ${kind} vide ou trop volumineux (max 2 Mo)`);
  if (bytes.subarray(0, 8).compare(PNG_MAGIC) !== 0) throw new EmaError("VALIDATION", `Fichier ${kind} : seul le PNG est accepté`);
  const { width, height } = pngDimensions(bytes);
  if (width < MIN_DIM || height < MIN_DIM || width > MAX_DIM || height > MAX_DIM) throw new EmaError("VALIDATION", `Fichier ${kind} : dimensions inattendues (${width}×${height})`);
  return { bytes, width, height, label: assetLabel(company, kind) };
}

/** Dimensions lues dans le chunk IHDR (les 8 octets après la signature + longueur + type). */
export function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") throw new EmaError("VALIDATION", "PNG corrompu (IHDR absent)");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
