import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { route, currentUser, ownedOr404 } from "@/lib/api";
import { getDocument } from "@/database/repositories/documents";
import { EmaError } from "@/lib/errors";
import { privateRoot, safeJoin } from "@/lib/paths";
import { servedFilePolicy } from "@/lib/content-safety";

/**
 * Sert un document archivé (original ou version signée) après authentification.
 * Politique de restitution : `src/lib/content-safety.ts` — seul un PDF est
 * affiché en ligne, tout le reste est téléchargé, et un contenu actif (HTML,
 * SVG, XML…) est neutralisé. Le chemin est toujours résolu par `safeJoin`.
 */
export const GET = route(async (req, ctx: { params: Promise<{ id: string }> }, sessionUser) => {
  const { id } = await ctx.params;
  const doc = ownedOr404(getDocument(id), currentUser(sessionUser), `Document ${id}`);
  const wantSigned = new URL(req.url).searchParams.get("version") === "signed";
  const relative = wantSigned ? doc.signed_path : doc.original_path;
  if (!relative) throw new EmaError("NOT_FOUND", "Version demandée indisponible");
  const file = safeJoin(privateRoot(), relative);
  if (!fs.existsSync(file)) throw new EmaError("NOT_FOUND", "Fichier absent du stockage");
  const policy = servedFilePolicy(doc.name || path.basename(relative), doc.mime_type);
  const data = fs.readFileSync(file);
  return new NextResponse(new Uint8Array(data), { headers: policy.headers });
});
