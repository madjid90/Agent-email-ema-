import { z } from "zod";
import { route, ok, parseBody, currentUser, ownedOr404 } from "@/lib/api";
import { editActionPayload } from "@/actions/engine";
import { getAction } from "@/database/repositories/actions";

/** Modification manuelle du brouillon avant validation. */
export const PUT = route(async (req, ctx: { params: Promise<{ id: string }> }, sessionUser) => {
  const { id } = await ctx.params;
  ownedOr404(getAction(id), currentUser(sessionUser), `Action ${id}`);
  const body = await parseBody(req, z.object({ body: z.string().min(1).max(20_000) }));
  return ok(editActionPayload(id, { body: body.body }, "user"));
});
