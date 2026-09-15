import { z } from "zod";
import { route, ok, parseBody } from "@/lib/api";
import { editActionPayload } from "@/actions/engine";

/** Modification manuelle du brouillon avant validation. */
export const PUT = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, z.object({ body: z.string().min(1).max(20_000) }));
  return ok(editActionPayload(id, { body: body.body }, "user"));
});
