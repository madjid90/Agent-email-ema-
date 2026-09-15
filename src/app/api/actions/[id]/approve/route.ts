import { route, ok } from "@/lib/api";
import { approveAndExecute } from "@/actions/engine";

export const POST = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return ok(await approveAndExecute(id, "user"));
});
