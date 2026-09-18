import { route, ok, currentUser, ownedOr404 } from "@/lib/api";
import { getConfiguredIntegrations } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { getDocument } from "@/database/repositories/documents";
import { analyzeDocument } from "@/documents/analyze";

/** (Ré)analyse explicite d'un document depuis l'interface. Aucune action créée ici. */
export const POST = route(async (_req, ctx: { params: Promise<{ id: string }> }, sessionUser) => {
  const { id } = await ctx.params;
  ownedOr404(getDocument(id), currentUser(sessionUser), `Document ${id}`);
  if (!getConfiguredIntegrations().anthropic) throw new EmaError("CONFIG", "ANTHROPIC_API_KEY non renseignée");
  const r = await analyzeDocument(id, { force: true, actor: "user" });
  const { original_path: _o, signed_path: _s, extracted_text: _t, ...safe } = r.document;
  return ok({ document: safe, extraction: r.extraction, duplicates: r.duplicates, skipped: r.skipped });
});
