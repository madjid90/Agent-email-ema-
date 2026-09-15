import { z } from "zod";
import { defineTool, emailSummarySchema } from "../types";
import * as emailsRepo from "@/database/repositories/emails";
import { listEmailsWithAnalysis } from "@/database/repositories/analyses";
import { describeAnalysis } from "@/agent/chat";
import { parseJson } from "@/database/types";
import { EmaError } from "@/lib/errors";
import { analysisStats } from "@/database/repositories/analyses";
import { listActions } from "@/database/repositories/actions";
import { searchDocuments } from "@/database/repositories/documents";
import { startOfTodayIso } from "@/lib/time";

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

export const getTodaySummary = defineTool({
  name: "get_today_summary",
  description: "Point de la journée : compteurs (urgents, à répondre, à valider, factures, devis à signer, demandes de paiement) et principaux éléments. Données locales uniquement.",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ since: z.string().optional().describe("Date ISO de début (défaut : aujourd'hui)") }),
  output: z.object({
    since: z.string(),
    counters: z.object({ urgent: z.number(), needs_reply: z.number(), pending_approval: z.number(), invoices: z.number(), quotes_to_sign: z.number(), payment_requests: z.number(), human_review: z.number() }),
    urgent_emails: z.array(z.object({ email_id: z.string(), subject: z.string(), from: z.string().nullable(), summary: z.string().nullable() })),
    pending_actions: z.array(z.object({ action_id: z.string(), type: z.string(), title: z.string(), risk_level: z.string() })),
    quotes_to_sign: z.array(z.object({ document_id: z.string(), supplier_name: z.string().nullable(), quote_number: z.string().nullable(), amount_incl_tax: z.number().nullable(), company_id: z.string().nullable() })),
  }),
  handler: async (input, ctx) => {
    const since = input.since ?? startOfTodayIso();
    const stats = analysisStats(since, ctx.db);
    const pending = listActions({ status: ["WAITING_APPROVAL", "PROPOSED"], limit: 20 }, ctx.db);
    const quotes = searchDocuments({ docType: "QUOTE", limit: 10 }, ctx.db).filter((d) => d.signed_document_id === null);
    const emails = listEmailsWithAnalysis({ since, limit: 50 }, ctx.db);
    return {
      since,
      counters: {
        urgent: stats.urgent,
        needs_reply: stats.needsReply,
        pending_approval: pending.length,
        invoices: stats.invoices,
        quotes_to_sign: quotes.length,
        payment_requests: pending.filter((a) => a.type === "payment_request" || a.type === "deposit_request").length,
        human_review: stats.humanReview,
      },
      urgent_emails: emails
        .filter((e) => e.urgency === "HIGH" || e.urgency === "CRITICAL" || e.category === "URGENT")
        .slice(0, 5)
        .map((e) => ({ email_id: e.email_id, subject: e.subject, from: e.sender_name ?? e.sender_email, summary: e.summary })),
      pending_actions: pending.slice(0, 10).map((a) => ({ action_id: a.id, type: a.type, title: a.title, risk_level: a.risk_level })),
      quotes_to_sign: quotes.map((d) => ({ document_id: d.id, supplier_name: d.supplier_name, quote_number: d.quote_number, amount_incl_tax: d.amount_incl_tax, company_id: d.company_id })),
    };
  },
});

export const analysisTools = [getEmailAnalysis, listRecentEmails, getTodaySummary];
