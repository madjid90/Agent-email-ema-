import { z } from "zod";
import { route, ok, parseBody } from "@/lib/api";
import { cancelFollowup, getFollowup, rescheduleFollowup } from "@/database/repositories/followups";
import { logHistory } from "@/database/repositories/history";
import { EmaError, NotImplementedError } from "@/lib/errors";
import { addDays } from "@/lib/time";
import { nowIso } from "@/lib/ids";

export const PATCH = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, z.object({ action: z.enum(["cancel", "postpone", "execute_now"]), days: z.number().int().min(1).max(60).default(3) }));
  const f = getFollowup(id);
  if (!f) throw new EmaError("NOT_FOUND", `Relance ${id} introuvable`);
  if (body.action === "cancel") {
    if (!cancelFollowup(id)) throw new EmaError("INVALID_TRANSITION", `Relance ${id} en statut ${f.status}`);
    logHistory({ eventType: "followup.cancelled", message: "Relance annulée par l'utilisateur", actor: "user", followupId: id, emailId: f.email_id });
  } else if (body.action === "postpone") {
    const executeAt = addDays(f.execute_at > nowIso() ? f.execute_at : nowIso(), body.days);
    if (!rescheduleFollowup(id, executeAt)) throw new EmaError("INVALID_TRANSITION", `Relance ${id} en statut ${f.status}`);
    logHistory({ eventType: "followup.postponed", message: `Relance reportée au ${executeAt}`, actor: "user", followupId: id, emailId: f.email_id });
  } else {
    throw new NotImplementedError("Exécution immédiate d'une relance", "phase 6");
  }
  return ok(getFollowup(id));
});
