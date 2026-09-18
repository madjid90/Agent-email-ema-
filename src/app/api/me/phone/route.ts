import { z } from "zod";
import { route, ok, parseBody, currentUser } from "@/lib/api";
import { logHistory } from "@/database/repositories/history";
import { clearPhone, publicUser, setPendingPhone } from "@/database/repositories/users";
import { getWhatsappActivation } from "@/integrations/whatsapp/activation";
import { maskE164 } from "@/lib/phone";

/** Enregistre le numéro à activer : il ne devient une identité qu'après le premier message WhatsApp. */
export const POST = route(async (req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  const { phone } = await parseBody(req, z.object({ phone: z.string().trim().min(6).max(30) }));
  const updated = setPendingPhone(user.id, phone);
  logHistory({ eventType: "whatsapp.phone_registered", message: `Numéro WhatsApp enregistré (${maskE164(updated.phone_number)}) : en attente du premier message`, actor: "user", userId: user.id });
  return ok({ user: publicUser(updated), whatsapp: getWhatsappActivation(updated) });
});

/** Désactivation : le numéro est retiré, EMA ne répond plus à ce numéro. */
export const DELETE = route(async (_req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  const updated = clearPhone(user.id);
  logHistory({ eventType: "whatsapp.deactivated", message: "WhatsApp désactivé pour ce compte", actor: "user", userId: user.id });
  return ok({ user: publicUser(updated), whatsapp: getWhatsappActivation(updated) });
});
