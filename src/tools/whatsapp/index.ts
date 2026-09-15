import { z } from "zod";
import { defineTool } from "../types";
import { getApproverPhone } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { getWhatsappClient, isWhatsappConfigured } from "@/integrations/whatsapp/client";
import { textMessage } from "@/integrations/whatsapp/messages";

/** Notification texte libre au numéro autorisé (interne, jamais exposé à Claude). */
export const sendWhatsappNotification = defineTool({
  name: "send_whatsapp_notification",
  description: "Interne : envoie une notification texte sur WhatsApp à l'utilisateur.",
  riskLevel: "LOW",
  modes: ["internal"],
  input: z.object({ text: z.string().min(1).max(4000) }),
  output: z.object({ message_id: z.string() }),
  handler: async (input) => {
    const to = getApproverPhone();
    if (!isWhatsappConfigured() || !to) throw new EmaError("CONFIG", "WhatsApp non configuré");
    const r = await getWhatsappClient().send(textMessage(to, input.text));
    return { message_id: r.messageId };
  },
});

export const whatsappTools = [sendWhatsappNotification];
