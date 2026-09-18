import { route, ok, currentUser, ownedOr404 } from "@/lib/api";
import { approveAndExecute } from "@/actions/engine";
import { getAction } from "@/database/repositories/actions";

export const POST = route(async (_req, ctx: { params: Promise<{ id: string }> }, sessionUser) => {
  const user = currentUser(sessionUser);
  const { id } = await ctx.params;
  ownedOr404(getAction(id), user, `Action ${id}`);
  return ok(await approveAndExecute(id, `user:${user.email}`));
});
