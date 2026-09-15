import { z } from "zod";
import { defineTool } from "../types";
import * as followupsRepo from "@/database/repositories/followups";
import * as emailsRepo from "@/database/repositories/emails";
import { logHistory } from "@/database/repositories/history";
import { EmaError } from "@/lib/errors";

export const scheduleFollowup = defineTool({
  name: "schedule_followup",
  description: "Programme une relance sur un thread à une date donnée si aucune réponse n'est reçue d'ici là.",
  riskLevel: "LOW",
  modes: ["analyze", "chat", "followup"],
  input: z.object({ email_id: z.string(), thread_id: z.string().optional(), execute_at: z.string(), reason: z.string().min(1), recipient: z.string().email().optional() }),
  output: z.object({ followup_id: z.string(), execute_at: z.string() }),
  handler: async (input, ctx) => {
    const e = emailsRepo.getEmail(input.email_id, ctx.db);
    if (!e) throw new EmaError("NOT_FOUND", `Email ${input.email_id} introuvable`);
    const threadId = input.thread_id ?? e.thread_id ?? e.id;
    if (Number.isNaN(new Date(input.execute_at).getTime())) throw new EmaError("VALIDATION", "execute_at doit être une date ISO");
    const f = followupsRepo.insertFollowup({ threadId, emailId: e.id, recipient: input.recipient ?? e.sender_email, reason: input.reason, executeAt: new Date(input.execute_at).toISOString() }, ctx.db);
    logHistory({ eventType: "followup.scheduled", message: `Relance programmée le ${f.execute_at} : ${input.reason}`, followupId: f.id, emailId: e.id }, ctx.db);
    return { followup_id: f.id, execute_at: f.execute_at };
  },
});

export const cancelFollowup = defineTool({
  name: "cancel_followup",
  description: "Annule une relance programmée.",
  riskLevel: "LOW",
  modes: ["chat", "followup"],
  input: z.object({ followup_id: z.string(), reason: z.string().optional() }),
  output: z.object({ ok: z.boolean() }),
  handler: async (input, ctx) => {
    const ok = followupsRepo.cancelFollowup(input.followup_id, ctx.db);
    if (ok) logHistory({ eventType: "followup.cancelled", message: `Relance annulée${input.reason ? ` : ${input.reason}` : ""}`, followupId: input.followup_id }, ctx.db);
    return { ok };
  },
});

export const checkReplyReceived = defineTool({
  name: "check_reply_received",
  description: "Vérifie si une réponse entrante est arrivée sur un thread depuis une date.",
  riskLevel: "LOW",
  modes: ["chat", "followup"],
  input: z.object({ thread_id: z.string(), since: z.string() }),
  output: z.object({ replied: z.boolean(), reply_email_id: z.string().nullable() }),
  handler: async (input, ctx) => {
    const reply = emailsRepo.listThread(input.thread_id, ctx.db).find((e) => e.direction === "inbound" && e.received_at > input.since);
    return { replied: Boolean(reply), reply_email_id: reply?.id ?? null };
  },
});

export const followupTools = [scheduleFollowup, cancelFollowup, checkReplyReceived];
