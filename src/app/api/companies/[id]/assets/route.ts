import fs from "node:fs";
import { route, ok } from "@/lib/api";
import { EmaError } from "@/lib/errors";
import { readConfig, writeConfig } from "@/lib/config";
import { privatePath, ensurePrivateDirs, sanitizeFilename } from "@/lib/paths";
import { logHistory } from "@/database/repositories/history";

const MAX_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Upload de la signature ou du tampon d'une société (PNG ≤ 2 Mo) dans
 * private/signatures ou private/stamps. Le fichier n'est jamais servi
 * publiquement et n'est jamais transmis à Claude.
 */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const form = await req.formData();
  const kind = form.get("kind");
  const file = form.get("file");
  if (kind !== "signature" && kind !== "stamp") throw new EmaError("VALIDATION", "kind doit être signature ou stamp");
  if (!(file instanceof File)) throw new EmaError("VALIDATION", "Fichier manquant");
  if (file.size > MAX_BYTES) throw new EmaError("VALIDATION", "Fichier trop volumineux (2 Mo max)");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 8).compare(PNG_MAGIC) !== 0) throw new EmaError("VALIDATION", "Seul le format PNG est accepté");

  const companies = readConfig("companies");
  const company = companies.companies.find((c) => c.id === id);
  if (!company) throw new EmaError("NOT_FOUND", `Société ${id} introuvable`);

  ensurePrivateDirs();
  const dir = kind === "signature" ? "signatures" : "stamps";
  const filename = sanitizeFilename(`${company.id}-${kind}.png`);
  fs.writeFileSync(privatePath(dir, filename), bytes);
  const relative = `${dir}/${filename}`;
  if (kind === "signature") company.signaturePath = relative;
  else company.stampPath = relative;
  writeConfig("companies", companies);
  logHistory({ eventType: `company.${kind}_uploaded`, message: `${kind === "signature" ? "Signature" : "Tampon"} mis à jour pour ${company.name}`, actor: "user" });
  return ok({ company_id: company.id, kind, path: relative });
});
