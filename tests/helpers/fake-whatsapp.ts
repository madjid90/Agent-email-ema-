import { WhatsappClient } from "@/integrations/whatsapp/client";
import type { WhatsappOutgoingMessage } from "@/integrations/whatsapp/types";
import { fakeFetch, json, type RecordedCall } from "./fake-graph";

/** Client WhatsApp branché sur un faux fetch ; `sent` contient les messages envoyés. */
export function fakeWhatsapp(opts: { fail?: (n: number) => Response | null } = {}) {
  const { fetchImpl, calls } = fakeFetch([
    {
      match: /POST .*graph\.facebook\.com\/v\d+\.\d+\/PHONE\/messages$/,
      handle: (_c, n) => opts.fail?.(n) ?? json({ messaging_product: "whatsapp", contacts: [{ wa_id: "33612345678" }], messages: [{ id: `wamid.${n}` }] }),
    },
  ]);
  const client = new WhatsappClient({ accessToken: "TOKEN", phoneNumberId: "PHONE", fetchImpl, sleep: async () => {} });
  const sent = (): WhatsappOutgoingMessage[] => calls.map((c: RecordedCall) => c.body as WhatsappOutgoingMessage);
  return { client, calls, sent };
}

/** Corps de webhook Meta pour un clic sur un bouton. */
export function buttonWebhook(from: string, buttonId: string, messageId = `wamid.in.${Math.random().toString(36).slice(2)}`) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "33100000000", phone_number_id: "PHONE" },
              contacts: [{ profile: { name: "Moi" }, wa_id: from }],
              messages: [{ from, id: messageId, timestamp: "1700000000", type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title: "✅ Valider" } } }],
            },
          },
        ],
      },
    ],
  };
}

/** Corps de webhook Meta pour un message texte entrant. */
export function textWebhook(from: string, body: string, messageId = `wamid.in.${Math.random().toString(36).slice(2)}`) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "33100000000", phone_number_id: "PHONE" },
              contacts: [{ profile: { name: "Moi" }, wa_id: from }],
              messages: [{ from, id: messageId, timestamp: "1700000000", type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  };
}
