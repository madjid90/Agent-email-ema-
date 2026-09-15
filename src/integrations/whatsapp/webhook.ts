import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { WhatsappInboundEvent } from "./types";

/** Vérification GET de Meta : hub.mode=subscribe, hub.verify_token, hub.challenge. */
export function verifySubscription(params: URLSearchParams, expectedToken: string | undefined): string | null {
  if (!expectedToken) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  const token = params.get("hub.verify_token") ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return params.get("hub.challenge");
}

/** Signature X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, corps brut). */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const given = header.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const messageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().optional(),
  type: z.string().optional(),
  text: z.object({ body: z.string() }).optional(),
  button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(),
  interactive: z
    .object({
      type: z.string().optional(),
      button_reply: z.object({ id: z.string(), title: z.string().optional() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string().optional() }).optional(),
    })
    .optional(),
});

const webhookSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string().optional(),
              value: z.object({ messages: z.array(messageSchema).optional() }).passthrough().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/** Ne garde que les messages utilisateur ; les statuts (delivered/read) sont ignorés. */
export function parseWebhook(json: unknown): WhatsappInboundEvent[] {
  const parsed = webhookSchema.safeParse(json);
  if (!parsed.success) return [];
  const events: WhatsappInboundEvent[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        const buttonId = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload ?? null;
        const buttonTitle = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.button?.text ?? null;
        events.push({
          kind: buttonId ? "button_reply" : m.type === "text" ? "text" : "other",
          messageId: m.id,
          from: m.from.replace(/\D/g, ""),
          timestamp: m.timestamp ?? null,
          buttonId,
          buttonTitle,
          text: m.text?.body ?? null,
        });
      }
    }
  }
  return events;
}

/** Boutons de rappel interne (phase 7) : done:<followup_id> / snooze:<followup_id>. */
export function parseReminderButtonId(id: string | null): { decision: "done" | "snooze"; followupId: string } | null {
  if (!id) return null;
  const m = /^(done|snooze):(fup_[a-f0-9]{6,40})$/.exec(id.trim());
  if (!m) return null;
  return { decision: m[1] as "done" | "snooze", followupId: m[2] as string };
}

/** Identifiants de boutons : approve:<approval_id> / reject:<approval_id>. */
export function parseButtonId(id: string | null): { decision: "approve" | "reject"; approvalId: string } | null {
  if (!id) return null;
  const m = /^(approve|reject):(apr_[a-f0-9]{6,40})$/.exec(id.trim());
  if (!m) return null;
  return { decision: m[1] as "approve" | "reject", approvalId: m[2] as string };
}
