import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { getDocument } from "@/database/repositories/documents";
import { EmaError } from "@/lib/errors";
import { privateRoot, safeJoin } from "@/lib/paths";

/** Sert un document archivé (original ou version signée) après authentification. */
export const GET = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const doc = getDocument(id);
  if (!doc) throw new EmaError("NOT_FOUND", `Document ${id} introuvable`);
  const wantSigned = new URL(req.url).searchParams.get("version") === "signed";
  const relative = wantSigned ? doc.signed_path : doc.original_path;
  if (!relative) throw new EmaError("NOT_FOUND", "Version demandée indisponible");
  const file = safeJoin(privateRoot(), relative);
  if (!fs.existsSync(file)) throw new EmaError("NOT_FOUND", "Fichier absent du stockage");
  const data = fs.readFileSync(file);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "content-type": doc.mime_type,
      "content-disposition": `inline; filename="${path.basename(relative)}"`,
      "cache-control": "private, no-store",
    },
  });
});
