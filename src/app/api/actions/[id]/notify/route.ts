import { route, ok } from "@/lib/api";
import { createApprovalRequest } from "@/actions/engine";
import { notifyPendingApproval } from "@/integrations/whatsapp";

/** (Re)crée la demande de validation si nécessaire et l'envoie sur WhatsApp. */
export const POST = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const approval = createApprovalRequest(id);
  const result = await notifyPendingApproval(id);
  return ok({ approval_id: approval.id, ...result });
});
