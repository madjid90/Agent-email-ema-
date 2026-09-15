import { z } from "zod";
import { defineTool } from "../types";
import { NotImplementedError } from "@/lib/errors";

/** Envoi d'une notification WhatsApp libre (interne, jamais exposé à Claude). */
export const sendWhatsappNotification = defineTool({
  name: "send_whatsapp_notification",
  description: "Interne : envoie une notification texte sur WhatsApp à l'utilisateur.",
  riskLevel: "LOW",
  modes: ["internal"],
  input: z.object({ text: z.string().min(1).max(4000) }),
  output: z.object({ message_id: z.string() }),
  handler: async () => {
    throw new NotImplementedError("send_whatsapp_notification", "phase 3");
  },
});

export const whatsappTools = [sendWhatsappNotification];
