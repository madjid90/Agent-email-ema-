import { route, ok } from "@/lib/api";
import { getConfiguredIntegrations } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { analyzeEmail } from "@/agent/orchestrator";
import { getEmail } from "@/database/repositories/emails";

/** Analyse ou réanalyse explicite d'un email depuis l'interface. Aucun envoi. */
export const POST = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!getEmail(id)) throw new EmaError("NOT_FOUND", `Email ${id} introuvable`);
  if (!getConfiguredIntegrations().anthropic) throw new EmaError("CONFIG", "ANTHROPIC_API_KEY non renseignée");
  const result = await analyzeEmail(id, { force: true, actor: "user" });
  return ok({ analysis: result.analysis, rules: result.rules.matched.map((r) => r.id), forward_to: result.rules.forwardTo, action_ids: result.actionIds });
});
