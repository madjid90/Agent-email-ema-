import { route, ok } from "@/lib/api";
import { retryAction } from "@/actions/engine";

/** Nouvelle tentative d'une action FAILED (déjà validée). */
export const POST = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return ok(await retryAction(id, "user"));
});
