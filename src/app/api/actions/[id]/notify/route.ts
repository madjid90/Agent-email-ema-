import { route, ok, currentUser, ownedOr404 } from "@/lib/api";
import { createApprovalRequest } from "@/actions/engine";
import { notifyPendingApproval } from "@/integrations/whatsapp";
import { getAction } from "@/database/repositories/actions";

/** (Re)crée la demande de validation si nécessaire et l'envoie sur le WhatsApp du propriétaire. */
export const POST = route(async (_req, ctx: { params: Promise<{ id: string }> }, sessionUser) => {
  const { id } = await ctx.params;
  ownedOr404(getAction(id), currentUser(sessionUser), `Action ${id}`);
  const approval = createApprovalRequest(id);
  const result = await notifyPendingApproval(id);
  return ok({ approval_id: approval.id, ...result });
});
