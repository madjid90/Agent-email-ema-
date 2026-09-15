/** Sous-ensemble de l'API WhatsApp Business Cloud utilisé par EMA. */

export interface WhatsappTextMessage {
  messaging_product: "whatsapp";
  to: string;
  type: "text";
  text: { body: string; preview_url?: boolean };
}

export interface WhatsappInteractiveButton {
  type: "reply";
  reply: { id: string; title: string };
}

export interface WhatsappInteractiveMessage {
  messaging_product: "whatsapp";
  to: string;
  type: "interactive";
  interactive: {
    type: "button";
    header?: { type: "text"; text: string };
    body: { text: string };
    footer?: { text: string };
    action: { buttons: WhatsappInteractiveButton[] };
  };
}

export type WhatsappOutgoingMessage = WhatsappTextMessage | WhatsappInteractiveMessage;

export interface WhatsappSendResponse {
  messaging_product?: string;
  contacts?: { input?: string; wa_id?: string }[];
  messages?: { id: string }[];
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

/** Événement entrant normalisé (après parsing du webhook). */
export interface WhatsappInboundEvent {
  kind: "button_reply" | "text" | "other";
  messageId: string;
  from: string; // chiffres uniquement
  timestamp: string | null;
  buttonId: string | null;
  buttonTitle: string | null;
  text: string | null;
}

/** Limites documentées des messages interactifs. */
export const WHATSAPP_LIMITS = {
  interactiveBody: 1024,
  interactiveHeader: 60,
  interactiveFooter: 60,
  buttonTitle: 20,
  buttonId: 256,
  textBody: 4096,
} as const;
