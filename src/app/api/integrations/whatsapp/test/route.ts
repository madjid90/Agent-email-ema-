import { route, ok } from "@/lib/api";
import { getWhatsappStatus, testWhatsappConnection } from "@/integrations/whatsapp";

/** Envoie un vrai message de test au numéro autorisé. */
export const POST = route(async () => {
  const test = await testWhatsappConnection();
  return ok({ ...getWhatsappStatus(), test });
});
