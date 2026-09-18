import { route, ok, currentUser, ownedOr404 } from "@/lib/api";
import { getEmail } from "@/database/repositories/emails";
import { getLatestAnalysis, listAnalysesForEmail } from "@/database/repositories/analyses";
import { listLlmRuns } from "@/database/repositories/llm-runs";

export const GET = route(async (_req, ctx: { params: Promise<{ id: string }> }, sessionUser) => {
  const { id } = await ctx.params;
  ownedOr404(getEmail(id), currentUser(sessionUser), `Email ${id}`);
  return ok({ latest: getLatestAnalysis(id) ?? null, history: listAnalysesForEmail(id), runs: listLlmRuns({ emailId: id }) });
});
