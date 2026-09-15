import { route, ok } from "@/lib/api";
import { EmaError } from "@/lib/errors";
import { getEmail } from "@/database/repositories/emails";
import { getLatestAnalysis, listAnalysesForEmail } from "@/database/repositories/analyses";
import { listLlmRuns } from "@/database/repositories/llm-runs";

export const GET = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (!getEmail(id)) throw new EmaError("NOT_FOUND", `Email ${id} introuvable`);
  return ok({ latest: getLatestAnalysis(id) ?? null, history: listAnalysesForEmail(id), runs: listLlmRuns({ emailId: id }) });
});
