import { z } from "zod";
import { route, ok, parseBody } from "@/lib/api";
import { getFollowup } from "@/database/repositories/followups";
import { EmaError } from "@/lib/errors";
import { cancelFollowup, completeReminder, postponeFollowup, processFollowup } from "@/followups/service";

/**
 * Actions sur une relance depuis l'interface : annuler, reporter, marquer un
 * rappel comme traité, ou traiter l'échéance immédiatement (vérification
 * Outlook puis brouillon soumis à validation — jamais d'envoi direct).
 */
export const PATCH = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, z.object({ action: z.enum(["cancel", "postpone", "prepare_now", "done"]), days: z.number().int().min(1).max(60).default(3) }));
  const f = getFollowup(id);
  if (!f) throw new EmaError("NOT_FOUND", `Relance ${id} introuvable`);

  if (body.action === "cancel") {
    return ok({ followup: cancelFollowup(id, "Annulée depuis l'interface", { actor: "user" }) });
  }
  if (body.action === "postpone") {
    return ok({ followup: postponeFollowup(id, { in_days: body.days }, { actor: "user" }) });
  }
  if (body.action === "done") {
    return ok({ followup: completeReminder(id, { actor: "user" }) });
  }
  const result = await processFollowup(id, { actor: "user" });
  return ok({ followup: getFollowup(id), outcome: result.outcome, action_id: result.actionId, message: result.message });
});
