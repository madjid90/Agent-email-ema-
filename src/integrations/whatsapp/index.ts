import { getConfiguredIntegrations } from "@/lib/env";
import { NotImplementedError } from "@/lib/errors";

/**
 * Intégration WhatsApp Business Cloud API (phase 3). Seule couche à lire WHATSAPP_*.
 */
export interface WhatsappStatus {
  configured: boolean;
  recipientConfigured: boolean;
}

export function getWhatsappStatus(): WhatsappStatus {
  const cfg = getConfiguredIntegrations();
  return { configured: cfg.whatsapp, recipientConfigured: Boolean(process.env.WHATSAPP_RECIPIENT_NUMBER) };
}

export interface ApprovalMessage {
  approvalId: string;
  sender: string;
  subject: string;
  summary: string;
  company?: string | null;
  amount?: string | null;
  proposedAction: string;
  proposedReply?: string | null;
}

/** Corps du message de validation (texte), utilisé par l'UI et l'envoi WhatsApp. */
export function formatApprovalMessage(m: ApprovalMessage): string {
  const lines = [
    "📩 Email reçu",
    "",
    `Expéditeur : ${m.sender}`,
    `Objet : ${m.subject}`,
    `Résumé : ${m.summary}`,
    m.company ? `Société détectée : ${m.company}` : null,
    m.amount ? `Montant : ${m.amount}` : null,
    "",
    `Action proposée : ${m.proposedAction}`,
    m.proposedReply ? `\nRéponse proposée :\n${m.proposedReply}` : null,
  ].filter((l): l is string => l !== null);
  return lines.join("\n").slice(0, 4000);
}

export async function sendApprovalRequest(_m: ApprovalMessage): Promise<{ messageId: string }> {
  throw new NotImplementedError("Envoi WhatsApp", "phase 3");
}

export async function testWhatsappConnection(): Promise<{ ok: boolean; message: string }> {
  const s = getWhatsappStatus();
  if (!s.configured) return { ok: false, message: "Variables WHATSAPP_* non renseignées" };
  if (!s.recipientConfigured) return { ok: false, message: "WHATSAPP_RECIPIENT_NUMBER non renseigné" };
  return { ok: false, message: "Envoi test : phase 3" };
}
