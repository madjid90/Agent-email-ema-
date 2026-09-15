import { z } from "zod";
import { defineTool, emailSummarySchema } from "../types";
import * as emailsRepo from "@/database/repositories/emails";
import { listEmailsWithAnalysis } from "@/database/repositories/analyses";
import { describeAnalysis } from "@/agent/chat";
import { parseJson } from "@/database/types";
import { EmaError } from "@/lib/errors";

/** Tools de lecture des analyses EMA (chat). Aucun effet de bord. */
export const getEmailAnalysis = defineTool({
  name: "get_email_analysis",
  description: "Renvoie l'analyse EMA d'un email (catégorie, urgence, résumé, société, montant, action recommandée, brouillon de réponse).",
  riskLevel: "LOW",
  modes: ["chat", "followup"],
  input: z.object({ email_id: z.string() }),
  output: z.record(z.string(), z.unknown()),
  handler: async (input, ctx) => {
    if (!emailsRepo.getEmail(input.email_id, ctx.db)) throw new EmaError("NOT_FOUND", `Email ${input.email_id} introuvable`);
    const a = describeAnalysis(input.email_id, ctx.db);
    return a ?? { email_id: input.email_id, analyzed: false, message: "Cet email n'a pas encore été analysé" };
  },
});

export const listRecentEmails = defineTool({
  name: "list_recent_emails",
  description: "Liste les derniers emails reçus avec leur analyse EMA (catégorie, urgence, résumé, réponse attendue, validation humaine).",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ max: z.number().int().min(1).max(50).default(20), category: z.string().optional(), needs_reply: z.boolean().optional(), since: z.string().optional() }),
  output: z.array(
    emailSummarySchema.extend({
      category: z.string().nullable(),
      urgency: z.string().nullable(),
      summary: z.string().nullable(),
      needs_reply: z.boolean(),
      requires_human_review: z.boolean(),
      status: z.string(),
    }),
  ),
  handler: async (input, ctx) => {
    const rows = listEmailsWithAnalysis({ limit: 200, since: input.since }, ctx.db)
      .filter((r) => (input.category ? r.category === input.category : true))
      .filter((r) => (input.needs_reply === undefined ? true : (r.needs_reply === 1) === input.needs_reply))
      .slice(0, input.max);
    return rows.map((r) => {
      const e = emailsRepo.getEmail(r.email_id, ctx.db);
      return {
        email_id: r.email_id,
        thread_id: e?.thread_id ?? null,
        from: { name: r.sender_name, email: r.sender_email },
        to: parseJson<string[]>(e?.to_recipients ?? "[]", []),
        subject: r.subject,
        received_at: r.received_at,
        preview: (r.summary ?? e?.body_preview ?? "").slice(0, 300),
        has_attachments: e?.has_attachments === 1,
        direction: "inbound" as const,
        category: r.category,
        urgency: r.urgency,
        summary: r.summary,
        needs_reply: r.needs_reply === 1,
        requires_human_review: r.requires_human_review === 1,
        status: r.status,
      };
    });
  },
});

export const analysisTools = [getEmailAnalysis, listRecentEmails];
