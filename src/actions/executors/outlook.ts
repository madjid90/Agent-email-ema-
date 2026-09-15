import fs from "node:fs";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as emailsRepo from "@/database/repositories/emails";
import * as documentsRepo from "@/database/repositories/documents";
import { EmaError } from "@/lib/errors";
import { privateRoot, safeJoin } from "@/lib/paths";
import { createLogger } from "@/lib/logger";
import { createConnectedGraphClient, type GraphClient } from "@/integrations/microsoft/graph-client";
import { findLatestSentInConversation, forwardMessage, replyToMessage, sendMail, toNewEmail, type OutgoingAttachment } from "@/integrations/microsoft/mail";
import { loadTokenSet } from "@/integrations/microsoft/token-store";
import type { ActionExecutor, ExecutionResult } from "../types";

const log = createLogger("executors.outlook");

/**
 * Exécuteurs Outlook : seuls points d'envoi réel. Ils ne sont appelés que par
 * l'Action Engine après validation (executeAction). Jamais depuis un tool.
 */
export interface OutlookExecutorDeps {
  db?: Db;
  client?: GraphClient;
  now?: () => Date;
}

function deps(d: OutlookExecutorDeps): { db: Db; client: GraphClient; now: () => Date } {
  const db = d.db ?? getDb();
  return { db, client: d.client ?? createConnectedGraphClient({ db }), now: d.now ?? (() => new Date()) };
}

function requireEmail(id: string, db: Db) {
  const e = emailsRepo.getEmail(id, db);
  if (!e) throw new EmaError("NOT_FOUND", `Email ${id} introuvable`);
  return e;
}

/** Charge des documents archivés comme pièces jointes sortantes (base64). */
export function loadOutgoingAttachments(documentIds: string[], db: Db): OutgoingAttachment[] {
  return documentIds.map((id) => {
    const doc = documentsRepo.getDocument(id, db);
    if (!doc) throw new EmaError("NOT_FOUND", `Document ${id} introuvable`);
    const relative = doc.signed_path ?? doc.original_path;
    const file = safeJoin(privateRoot(), relative);
    if (!fs.existsSync(file)) throw new EmaError("NOT_FOUND", `Fichier absent : ${doc.name}`);
    return { name: doc.signed_path ? doc.name.replace(/\.pdf$/i, "") + "-signe.pdf" : doc.name, contentType: doc.mime_type, contentBytesBase64: fs.readFileSync(file).toString("base64") };
  });
}

/** Trace le message envoyé (Sent Items) comme email sortant du thread, best effort. */
async function recordSentMessage(client: GraphClient, db: Db, conversationId: string | null, since: string): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const sent = await findLatestSentInConversation(client, conversationId, since);
    if (!sent) return null;
    const existing = emailsRepo.getEmailByGraphId(sent.id, db);
    if (existing) return existing.id;
    const accountEmail = loadTokenSet(db)?.accountEmail ?? null;
    return emailsRepo.insertEmail(toNewEmail(sent, { accountEmail, direction: "outbound", status: "PROCESSED" }), db).id;
  } catch (err) {
    log.warn("could not record sent message", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export function createOutlookExecutors(d: OutlookExecutorDeps = {}): ActionExecutor[] {
  const replyEmail: ActionExecutor<"reply_email"> = {
    type: "reply_email",
    async execute(payload): Promise<ExecutionResult> {
      const { db, client, now } = deps(d);
      const email = requireEmail(payload.email_id, db);
      const since = new Date(now().getTime() - 60_000).toISOString();
      await replyToMessage(client, email.graph_id, { comment: payload.body, replyAll: payload.reply_all, attachments: loadOutgoingAttachments(payload.attachments, db) });
      const sentId = await recordSentMessage(client, db, email.thread_id, since);
      emailsRepo.updateEmailStatus(email.id, "PROCESSED", db);
      return { ok: true, summary: `Réponse envoyée à ${email.sender_email ?? "?"} — ${email.subject}`, data: { sent_email_id: sentId } };
    },
  };

  const forwardEmail: ActionExecutor<"forward_email"> = {
    type: "forward_email",
    async execute(payload): Promise<ExecutionResult> {
      const { db, client, now } = deps(d);
      const email = requireEmail(payload.email_id, db);
      const since = new Date(now().getTime() - 60_000).toISOString();
      await forwardMessage(client, email.graph_id, { to: payload.to, comment: payload.comment });
      const sentId = await recordSentMessage(client, db, email.thread_id, since);
      emailsRepo.updateEmailStatus(email.id, "PROCESSED", db);
      return { ok: true, summary: `Email transféré à ${payload.to.join(", ")} — ${email.subject}`, data: { sent_email_id: sentId } };
    },
  };

  const sendEmail: ActionExecutor<"send_email"> = {
    type: "send_email",
    async execute(payload): Promise<ExecutionResult> {
      const { db, client } = deps(d);
      await sendMail(client, { to: payload.to, subject: payload.subject, body: payload.body, attachments: loadOutgoingAttachments(payload.attachments, db) });
      return { ok: true, summary: `Email envoyé à ${payload.to.join(", ")} — ${payload.subject}` };
    },
  };

  const paymentRequest: ActionExecutor<"payment_request"> = {
    type: "payment_request",
    async execute(payload): Promise<ExecutionResult> {
      const { client } = deps(d);
      await sendMail(client, { to: payload.to, subject: payload.subject, body: payload.body });
      return { ok: true, summary: `Demande de règlement envoyée à ${payload.to.join(", ")}` };
    },
  };

  const depositRequest: ActionExecutor<"deposit_request"> = { ...paymentRequest, type: "deposit_request" };

  return [replyEmail, forwardEmail, sendEmail, paymentRequest, depositRequest] as ActionExecutor[];
}
