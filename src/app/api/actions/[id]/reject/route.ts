import { z } from "zod";
import { route, ok, parseBody, currentUser, ownedOr404 } from "@/lib/api";
import { rejectAction } from "@/actions/engine";
import { getAction } from "@/database/repositories/actions";

export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }, sessionUser) => {
  const user = currentUser(sessionUser);
  const { id } = await ctx.params;
  ownedOr404(getAction(id), user, `Action ${id}`);
  const body = req.headers.get("content-type")?.includes("json") ? await parseBody(req, z.object({ reason: z.string().optional() })) : { reason: undefined };
  return ok(rejectAction(id, "user", body.reason));
});
