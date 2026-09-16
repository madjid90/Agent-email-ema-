import { z } from "zod";
import { route, ok } from "@/lib/api";
import { readConfig, writeConfig } from "@/lib/config";
import { EmaError } from "@/lib/errors";
import { logHistory } from "@/database/repositories/history";
import { MAX_ASSET_BYTES, removeAsset, storeAsset } from "@/documents/assets";

const kindSchema = z.enum(["signature", "stamp"]);

/**
 * Import d'une signature ou d'un tampon (PNG) depuis l'interface authentifiée.
 * Le fichier est vérifié (taille, magic bytes, IHDR, dimensions), renommé par le
 * serveur et écrit dans `private/` — jamais dans `public/`. Le chemin est ensuite
 * enregistré dans `config/companies.json`.
 */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const form = await req.formData().catch(() => {
    throw new EmaError("VALIDATION", "Envoi invalide : formulaire multipart attendu");
  });
  const kind = kindSchema.parse(form.get("kind"));
  const file = form.get("file");
  if (!(file instanceof File)) throw new EmaError("VALIDATION", "Aucun fichier reçu");
  if (file.size > MAX_ASSET_BYTES) throw new EmaError("VALIDATION", `Fichier trop volumineux (max ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} Mo)`);

  const config = readConfig("companies");
  const company = config.companies.find((c) => c.id === id);
  if (!company) throw new EmaError("NOT_FOUND", `Société ${id} introuvable`);

  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = storeAsset(company.id, kind, bytes);
  const previous = kind === "signature" ? company.signaturePath : company.stampPath;

  const updated = {
    ...config,
    companies: config.companies.map((c) => (c.id === id ? { ...c, ...(kind === "signature" ? { signaturePath: stored.relativePath } : { stampPath: stored.relativePath }) } : c)),
  };
  writeConfig("companies", updated);
  if (previous && previous !== stored.relativePath) removeAsset(previous);

  logHistory({
    eventType: kind === "signature" ? "company.signature_uploaded" : "company.stamp_uploaded",
    message: `${kind === "signature" ? "Signature" : "Tampon"} importé pour ${company.name} (${stored.width}×${stored.height}, ${Math.round(stored.bytes / 1024)} Ko)`,
    actor: "user",
  });
  // Le chemin relatif (dans private/) est renvoyé à l'interface authentifiée pour
  // qu'elle reste synchronisée ; il n'est jamais transmis au modèle.
  return ok({ company_id: company.id, kind, path: stored.relativePath, width: stored.width, height: stored.height, size: stored.bytes, available: true });
});

/** Supprime la signature ou le tampon configuré. */
export const DELETE = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const kind = kindSchema.parse(new URL(req.url).searchParams.get("kind"));
  const config = readConfig("companies");
  const company = config.companies.find((c) => c.id === id);
  if (!company) throw new EmaError("NOT_FOUND", `Société ${id} introuvable`);
  const previous = kind === "signature" ? company.signaturePath : company.stampPath;
  writeConfig("companies", {
    ...config,
    companies: config.companies.map((c) => (c.id === id ? { ...c, ...(kind === "signature" ? { signaturePath: null } : { stampPath: null }) } : c)),
  });
  removeAsset(previous);
  logHistory({ eventType: "company.asset_removed", message: `${kind === "signature" ? "Signature" : "Tampon"} retiré pour ${company.name}`, actor: "user" });
  return ok({ company_id: company.id, kind, available: false });
});
