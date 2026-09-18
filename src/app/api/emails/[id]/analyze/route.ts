import { route, ok, currentUser, ownedOr404 } from "@/lib/api";
import { getConfiguredIntegrations } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { analyzeEmail } from "@/agent/orchestrator";
import { getEmail } from "@/database/repositories/emails";

/** Analyse ou réanalyse explicite d'un email depuis l'interface. Aucun envoi. */
export const POST = route(async (_req, ctx: { params: Promise<{ id: string }> }, sessionUser) => {
  const { id } = await ctx.params;
  ownedOr404(getEmail(id), currentUser(sessionUser), `Email ${id}`);
  if (!getConfiguredIntegrations().anthropic) throw new EmaError("CONFIG", "ANTHROPIC_API_KEY non renseignée");
  const result = await analyzeEmail(id, { force: true, actor: "user" });
  return ok({ analysis: result.analysis, rules: result.rules.matched.map((r) => r.id), forward_to: result.rules.forwardTo, action_ids: result.actionIds });
});
