import { route, ok } from "@/lib/api";
import { EmaError } from "@/lib/errors";
import { getDocument } from "@/database/repositories/documents";
import { listHistory } from "@/database/repositories/history";
import { readExtraction } from "@/documents/analyze";
import { parseJson } from "@/database/types";
import type { DuplicateMatch } from "@/documents/types";

export const GET = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const doc = getDocument(id);
  if (!doc) throw new EmaError("NOT_FOUND", `Document ${id} introuvable`);
  // Le chemin privé n'est jamais renvoyé.
  const { original_path: _o, signed_path: _s, extracted_text: _t, ...safe } = doc;
  return ok({ document: safe, extraction: readExtraction(doc), duplicates: parseJson<DuplicateMatch[]>(doc.duplicate_of, []), history: listHistory({ limit: 50 }).filter((h) => h.document_id === id) });
});
