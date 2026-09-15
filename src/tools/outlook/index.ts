import { z } from "zod";
import { defineTool, emailFullSchema, emailSummarySchema, actionRefSchema } from "../types";
import * as emailsRepo from "@/database/repositories/emails";
import * as documentsRepo from "@/database/repositories/documents";
import type { EmailRow } from "@/database/types";
import type { Db } from "@/database/connection";
import { parseJson } from "@/database/types";
import { EmaError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { proposeAction } from "@/actions/engine";
import { createConnectedGraphClient, isOutlookConnected, type GraphClient } from "@/integrations/microsoft/graph-client";
import { searchMessages } from "@/integrations/microsoft/mail";
import { fetchAttachmentDocument, listAttachments } from "@/integrations/microsoft/attachments";
import { importConversation, upsertContextMessage } from "@/integrations/microsoft/sync";
import { loadTokenSet } from "@/integrations/microsoft/token-store";

/**
 * Tools Outlook. Les lectures passent par SQLite puis Microsoft Graph (thread,
 * recherche, pièces jointes). Les envois ne font JAMAIS d'effet direct : ils
 * créent une action dans l'Action Engine.
 */

/** Client Graph injectable (tests) ; par défaut, relié aux tokens stockés. */
type ClientFactory = (db: Db) => GraphClient;
const defaultFactory: ClientFactory = (db) => createConnectedGraphClient({ db });
let clientFactory: ClientFactory = defaultFactory;

export function setGraphClientFactoryForTests(factory: ClientFactory | null): void {
  clientFactory = factory ?? defaultFactory;
}

function requireClient(db: Db): GraphClient {
  if (!isOutlookConnected(db)) throw new EmaError("CONFIG", "Outlook n'est pas connecté");
  return clientFactory(db);
}

const MAX_THREAD = 20;

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

async function attachmentsOf(e: EmailRow, ctx: { db: Db }) {
  const stored = documentsRepo.listDocuments({ emailId: e.id }, ctx.db).filter((d) => d.attachment_id);
  if (stored.length > 0 || e.has_attachments !== 1 || !isOutlookConnected(ctx.db)) {
    return stored.map((d) => ({ attachment_id: d.attachment_id as string, name: d.name, mime: d.mime_type, size: d.size, document_id: d.id }));
  }
  const metas = await listAttachments(clientFactory(ctx.db), e.graph_id);
  return metas.filter((m) => m.isFile && !m.isInline).map((m) => ({ attachment_id: m.id, name: m.name, mime: m.contentType, size: m.size, document_id: null }));
}

const emailWithAttachments = emailFullSchema.extend({
  attachments: z.array(z.object({ attachment_id: z.string(), name: z.string(), mime: z.string(), size: z.number(), document_id: z.string().nullable() })),
});

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
  description: "Récupère un email complet (corps texte, liste des pièces jointes) par son identifiant EMA.",
  riskLevel: "LOW",
  modes: ["analyze", "chat", "followup"],
  input: z.object({ email_id: z.string() }),
  output: emailWithAttachments,
  handler: async (input, ctx) => {
    const e = emailsRepo.getEmail(input.email_id, ctx.db);
    if (!e) throw new EmaError("NOT_FOUND", `Email ${input.email_id} introuvable`);
    return { ...toSummary(e), body: e.body_text ?? e.body_preview, attachments: await attachmentsOf(e, ctx) };
  },
});

export const getEmailThread = defineTool({
  name: "get_email_thread",
  description: "Récupère la conversation complète d'un email (tous les messages du thread, du plus ancien au plus récent, bornée à 20 messages).",
  riskLevel: "LOW",
  modes: ["analyze", "chat", "followup"],
  input: z.object({ email_id: z.string().optional(), thread_id: z.string().optional() }).refine((v) => v.email_id || v.thread_id, "email_id ou thread_id requis"),
  output: z.array(emailFullSchema),
  handler: async (input, ctx) => {
    let threadId = input.thread_id ?? null;
    if (!threadId && input.email_id) threadId = emailsRepo.getEmail(input.email_id, ctx.db)?.thread_id ?? null;
    if (!threadId) return [];
    const rows = isOutlookConnected(ctx.db) ? await importConversation(clientFactory(ctx.db), threadId, { db: ctx.db, max: MAX_THREAD }) : emailsRepo.listThread(threadId, ctx.db).slice(-MAX_THREAD);
    return rows.map((e) => ({ ...toSummary(e), body: (e.body_text ?? e.body_preview).slice(0, 8000), attachments: [] }));
  },
});

export const searchEmails = defineTool({
  name: "search_emails",
  description: "Recherche des emails dans Outlook par mots-clés, expéditeur ou date (résultats bornés).",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ query: z.string().min(1), from: z.string().optional(), since: z.string().optional(), max: z.number().int().min(1).max(50).default(10) }),
  output: z.array(emailSummarySchema),
  handler: async (input, ctx) => {
    if (isOutlookConnected(ctx.db)) {
      const accountEmail = loadTokenSet(ctx.db)?.accountEmail ?? null;
      const found = await searchMessages(clientFactory(ctx.db), input);
      return found.map((m) => toSummary(upsertContextMessage(m, accountEmail, ctx.db)));
    }
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
  description: "Télécharge une pièce jointe dans le stockage privé (si ce n'est pas déjà fait) et renvoie son identifiant de document.",
  riskLevel: "LOW",
  modes: ["analyze", "chat"],
  input: z.object({ email_id: z.string(), attachment_id: z.string() }),
  output: z.object({ document_id: z.string(), name: z.string(), mime: z.string(), size: z.number(), text_preview: z.string().nullable() }),
  handler: async (input, ctx) => {
    const e = emailsRepo.getEmail(input.email_id, ctx.db);
    if (!e) throw new EmaError("NOT_FOUND", `Email ${input.email_id} introuvable`);
    const existing = documentsRepo.getDocumentByAttachment(e.id, input.attachment_id, ctx.db);
    const doc = existing ?? (await fetchAttachmentDocument(requireClient(ctx.db), e, input.attachment_id, Math.round(getEnv().ATTACHMENT_MAX_MB * 1024 * 1024), ctx.db));
    return { document_id: doc.id, name: doc.name, mime: doc.mime_type, size: doc.size, text_preview: doc.extracted_text ? doc.extracted_text.slice(0, 500) : null };
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
