import { WHATSAPP_LIMITS, type WhatsappInteractiveMessage, type WhatsappTextMessage } from "./types";

export interface ApprovalMessageInput {
  approvalId: string;
  kind: string; // reply_email, forward_email, ...
  senderName: string | null;
  senderEmail: string | null;
  company: string | null;
  subject: string;
  summary: string | null;
  proposedAction: string;
  proposedReply: string | null;
  confidence: number | null;
  humanReviewNote: string | null;
}

const ACTION_TITLES: Record<string, string> = {
  reply_email: "Réponse à valider",
  forward_email: "Transfert à valider",
  send_email: "Email à valider",
  payment_request: "Demande de règlement à valider",
  deposit_request: "Demande d'acompte à valider",
  sign_document: "Signature à valider",
  send_followup: "Relance à valider",
};

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Corps lisible et compact du message de validation. */
export function formatApprovalBody(m: ApprovalMessageInput): string {
  const lines: string[] = [`📩 EMA — ${ACTION_TITLES[m.kind] ?? "Action à valider"}`, ""];
  lines.push(`De : ${m.senderName ?? m.senderEmail ?? "—"}${m.senderName && m.senderEmail ? ` <${m.senderEmail}>` : ""}`);
  if (m.company) lines.push(`Entreprise : ${m.company}`);
  lines.push(`Objet : ${m.subject || "(sans objet)"}`);
  if (m.summary) lines.push("", `Résumé : ${m.summary}`);
  lines.push("", `Action proposée : ${m.proposedAction}`);
  if (m.proposedReply) lines.push("", "Réponse proposée :", `"${m.proposedReply.trim()}"`);
  if (m.confidence !== null) lines.push("", `Confiance : ${Math.round(m.confidence * 100)} %`);
  if (m.humanReviewNote) lines.push(`⚠ ${m.humanReviewNote}`);
  return lines.join("\n");
}

/**
 * Messages à envoyer : un seul message interactif si le corps tient dans la
 * limite Meta (1024 caractères), sinon le détail complet en texte puis un
 * message interactif court avec les boutons.
 */
export function buildApprovalMessages(to: string, m: ApprovalMessageInput): (WhatsappTextMessage | WhatsappInteractiveMessage)[] {
  const body = formatApprovalBody(m);
  const buttons: WhatsappInteractiveMessage["interactive"]["action"]["buttons"] = [
    { type: "reply", reply: { id: `approve:${m.approvalId}`, title: "✅ Valider" } },
    { type: "reply", reply: { id: `reject:${m.approvalId}`, title: "❌ Refuser" } },
  ];
  const interactive = (text: string): WhatsappInteractiveMessage => ({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "button", body: { text }, footer: { text: cut("Valider envoie réellement l'email.", WHATSAPP_LIMITS.interactiveFooter) }, action: { buttons } },
  });
  if (body.length <= WHATSAPP_LIMITS.interactiveBody) return [interactive(body)];
  const short = `📩 EMA — ${ACTION_TITLES[m.kind] ?? "Action à valider"}\nObjet : ${cut(m.subject || "(sans objet)", 120)}\nDétails dans le message précédent.`;
  return [{ messaging_product: "whatsapp", to, type: "text", text: { body: cut(body, WHATSAPP_LIMITS.textBody) } }, interactive(short)];
}

export function textMessage(to: string, body: string): WhatsappTextMessage {
  return { messaging_product: "whatsapp", to, type: "text", text: { body: cut(body, WHATSAPP_LIMITS.textBody) } };
}

export const TEST_MESSAGE = "✅ EMA est correctement connecté à WhatsApp.";
