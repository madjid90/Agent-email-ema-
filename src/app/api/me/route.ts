import { route, ok, currentUser } from "@/lib/api";
import { publicUser } from "@/database/repositories/users";
import { getOutlookStatus } from "@/integrations/microsoft";
import { getWhatsappActivation } from "@/integrations/whatsapp/activation";

/** Compte connecté et état de ses connexions (jamais de token). */
export const GET = route(async (_req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  return ok({ user: publicUser(user), outlook: getOutlookStatus(undefined, user.id), whatsapp: getWhatsappActivation(user) });
});
