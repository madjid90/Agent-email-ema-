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
  /** Lignes supplémentaires (facture : fournisseur, numéro, montant, échéance). */
  details?: { label: string; value: string }[];
  /** Note finale (ex. « EMA n'effectuera aucun paiement bancaire »). */
  note?: string | null;
}

const ACTION_TITLES: Record<string, string> = {
  reply_email: "📩 EMA — Réponse à valider",
  forward_email: "📄 EMA — Facture à traiter",
  send_email: "📩 EMA — Email à valider",
  payment_request: "💳 EMA — Demande de paiement",
  deposit_request: "💳 EMA — Demande d'acompte",
  sign_document: "📄 EMA — Devis à signer",
  send_followup: "⏰ EMA — Relance à valider",
};
const DEFAULT_TITLE = "📩 EMA — Action à valider";

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Corps lisible et compact du message de validation. */
export function formatApprovalBody(m: ApprovalMessageInput): string {
  const lines: string[] = [ACTION_TITLES[m.kind] ?? DEFAULT_TITLE, ""];
  lines.push(`De : ${m.senderName ?? m.senderEmail ?? "—"}${m.senderName && m.senderEmail ? ` <${m.senderEmail}>` : ""}`);
  if (m.company) lines.push(`Entreprise : ${m.company}`);
  lines.push(`Objet : ${m.subject || "(sans objet)"}`);
  for (const d of m.details ?? []) lines.push(`${d.label} : ${d.value}`);
  if (m.summary) lines.push("", `Résumé : ${m.summary}`);
  lines.push("", `Action proposée : ${m.proposedAction}`);
  if (m.proposedReply) lines.push("", m.kind === "reply_email" ? "Réponse proposée :" : "Message proposé :", `"${m.proposedReply.trim()}"`);
  if (m.confidence !== null) lines.push("", `Confiance : ${Math.round(m.confidence * 100)} %`);
  if (m.humanReviewNote) lines.push(`⚠ ${m.humanReviewNote}`);
  if (m.note) lines.push("", m.note);
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
  const short = `${ACTION_TITLES[m.kind] ?? DEFAULT_TITLE}\nObjet : ${cut(m.subject || "(sans objet)", 120)}\nDétails dans le message précédent.`;
  return [{ messaging_product: "whatsapp", to, type: "text", text: { body: cut(body, WHATSAPP_LIMITS.textBody) } }, interactive(short)];
}

export function textMessage(to: string, body: string): WhatsappTextMessage {
  return { messaging_product: "whatsapp", to, type: "text", text: { body: cut(body, WHATSAPP_LIMITS.textBody) } };
}

export const TEST_MESSAGE = "✅ EMA est correctement connecté à WhatsApp.";
