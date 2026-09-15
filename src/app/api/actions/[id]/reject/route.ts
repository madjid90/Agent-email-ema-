import { z } from "zod";
import { route, ok, parseBody } from "@/lib/api";
import { rejectAction } from "@/actions/engine";

export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = req.headers.get("content-type")?.includes("json") ? await parseBody(req, z.object({ reason: z.string().optional() })) : { reason: undefined };
  return ok(rejectAction(id, "user", body.reason));
});
