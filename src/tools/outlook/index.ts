import { z } from "zod";
import { defineTool, emailFullSchema, emailSummarySchema, actionRefSchema } from "../types";
import * as emailsRepo from "@/database/repositories/emails";
import type { EmailRow } from "@/database/types";
import { parseJson } from "@/database/types";
import { NotImplementedError, EmaError } from "@/lib/errors";
import { proposeAction } from "@/actions/engine";

/**
 * Tools Outlook. En phase 0, les lectures s'appuient sur la base locale
 * (emails déjà synchronisés) ; l'accès Graph arrive en phase 1.
 * Les envois ne font JAMAIS d'effet direct : ils créent une action.
 */

function toSummary(e: EmailRow) {
  return {
    email_id: e.id,
    thread_id: e.thread_id,
    from: { name: e.sender_name, email: e.sender_email },
    to: parseJson<string[]>(e.to_recipients, []),
    subject: e.subject,
    received_at: e.received_at,
    preview: e.body_preview,
    has_attachments: e.has_attachments === 1,
    direction: e.direction,
  };
}

export const getNewEmails = defineTool({
  name: "get_new_emails",
  description: "Liste les nouveaux emails reçus non encore traités (synchronisés depuis Outlook).",
  riskLevel: "LOW",
  modes: ["internal"],
  input: z.object({ since: z.string().optional(), max: z.number().int().min(1).max(100).default(25) }),
  output: z.array(emailSummarySchema),
  handler: async (input, ctx) => emailsRepo.listEmails({ status: "NEW", limit: input.max, since: input.since }, ctx.db).map(toSummary),
});

export const getEmail = defineTool({
  name: "get_email",
  description: "Récupère un email (corps complet et pièces jointes) par son identifiant EMA.",
  riskLevel: "LOW",
  modes: ["analyze", "chat", "followup"],
  input: z.object({ email_id: z.string() }),
  output: emailFullSchema,
  handler: async (input, ctx) => {
    const e = emailsRepo.getEmail(input.email_id, ctx.db);
    if (!e) throw new EmaError("NOT_FOUND", `Email ${input.email_id} introuvable`);
    return { ...toSummary(e), body: e.body_text ?? e.body_preview, attachments: [] };
  },
});

export const getEmailThread = defineTool({
  name: "get_email_thread",
  description: "Récupère tous les emails d'un thread, du plus ancien au plus récent.",
  riskLevel: "LOW",
  modes: ["analyze", "chat", "followup"],
  input: z.object({ email_id: z.string().optional(), thread_id: z.string().optional() }).refine((v) => v.email_id || v.thread_id, "email_id ou thread_id requis"),
  output: z.array(emailFullSchema),
  handler: async (input, ctx) => {
    let threadId = input.thread_id ?? null;
    if (!threadId && input.email_id) threadId = emailsRepo.getEmail(input.email_id, ctx.db)?.thread_id ?? null;
    if (!threadId) return [];
    return emailsRepo.listThread(threadId, ctx.db).map((e) => ({ ...toSummary(e), body: e.body_text ?? e.body_preview, attachments: [] }));
  },
});

export const searchEmails = defineTool({
  name: "search_emails",
  description: "Recherche des emails par expéditeur, objet ou mots-clés.",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ query: z.string().min(1), from: z.string().optional(), since: z.string().optional(), max: z.number().int().min(1).max(50).default(10) }),
  output: z.array(emailSummarySchema),
  handler: async (input, ctx) => {
    const like = `%${input.query.toLowerCase()}%`;
    const rows = ctx.db
      .prepare(
        `SELECT * FROM emails WHERE (lower(subject) LIKE @q OR lower(body_preview) LIKE @q OR lower(sender_email) LIKE @q OR lower(sender_name) LIKE @q)
         AND (@from IS NULL OR lower(sender_email) LIKE @from) AND (@since IS NULL OR received_at >= @since)
         ORDER BY received_at DESC LIMIT @max`,
      )
      .all({ q: like, from: input.from ? `%${input.from.toLowerCase()}%` : null, since: input.since ?? null, max: input.max }) as EmailRow[];
    return rows.map(toSummary);
  },
});

export const getAttachment = defineTool({
  name: "get_attachment",
  description: "Télécharge une pièce jointe dans le stockage privé et renvoie son identifiant de document.",
  riskLevel: "LOW",
  modes: ["analyze", "chat"],
  input: z.object({ email_id: z.string(), attachment_id: z.string() }),
  output: z.object({ document_id: z.string(), name: z.string(), mime: z.string(), size: z.number(), text_preview: z.string().nullable() }),
  handler: async () => {
    throw new NotImplementedError("get_attachment (Microsoft Graph)", "phase 1");
  },
});

export const replyEmail = defineTool({
  name: "reply_email",
  description: "Propose une réponse dans le thread de l'email. Crée une action qui sera validée avant envoi.",
  riskLevel: "MEDIUM",
  modes: ["analyze", "chat", "followup"],
  input: z.object({ email_id: z.string(), body: z.string().min(1), reply_all: z.boolean().default(false), attachments: z.array(z.string()).default([]) }),
  output: actionRefSchema,
  handler: async (input, ctx) => {
    const e = emailsRepo.getEmail(input.email_id, ctx.db);
    if (!e) throw new EmaError("NOT_FOUND", `Email ${input.email_id} introuvable`);
    const a = proposeAction({ type: "reply_email", title: `Répondre à ${e.sender_name ?? e.sender_email ?? "?"} — ${e.subject}`, payload: input, sourceEmailId: e.id }, { db: ctx.db, settings: ctx.settings });
    return { action_id: a.id, status: a.status, requires_approval: a.requires_approval === 1 };
  },
});

export const forwardEmail = defineTool({
  name: "forward_email",
  description: "Propose de transférer l'email à un ou plusieurs destinataires (issus des règles/contacts). Crée une action à valider.",
  riskLevel: "MEDIUM",
  modes: ["analyze", "chat"],
  input: z.object({ email_id: z.string(), to: z.array(z.string().email()).min(1), comment: z.string().default("") }),
  output: actionRefSchema,
  handler: async (input, ctx) => {
    const e = emailsRepo.getEmail(input.email_id, ctx.db);
    if (!e) throw new EmaError("NOT_FOUND", `Email ${input.email_id} introuvable`);
    const a = proposeAction({ type: "forward_email", title: `Transférer « ${e.subject} » à ${input.to.join(", ")}`, payload: input, sourceEmailId: e.id }, { db: ctx.db, settings: ctx.settings });
    return { action_id: a.id, status: a.status, requires_approval: a.requires_approval === 1 };
  },
});

export const sendEmail = defineTool({
  name: "send_email",
  description: "Propose l'envoi d'un nouvel email. Crée une action à valider.",
  riskLevel: "MEDIUM",
  modes: ["chat"],
  input: z.object({ to: z.array(z.string().email()).min(1), subject: z.string().min(1), body: z.string().min(1), attachments: z.array(z.string()).default([]) }),
  output: actionRefSchema,
  handler: async (input, ctx) => {
    const a = proposeAction({ type: "send_email", title: `Envoyer « ${input.subject} » à ${input.to.join(", ")}`, payload: { ...input, thread_id: null } }, { db: ctx.db, settings: ctx.settings });
    return { action_id: a.id, status: a.status, requires_approval: a.requires_approval === 1 };
  },
});

export const outlookTools = [getNewEmails, getEmail, getEmailThread, searchEmails, getAttachment, replyEmail, forwardEmail, sendEmail];
