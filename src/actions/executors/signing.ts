import fs from "node:fs";
import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as documentsRepo from "@/database/repositories/documents";
import * as emailsRepo from "@/database/repositories/emails";
import { logHistory } from "@/database/repositories/history";
import { EmaError } from "@/lib/errors";
import { privateRoot, safeJoin } from "@/lib/paths";
import { createLogger } from "@/lib/logger";
import { createConnectedGraphClient, type GraphClient } from "@/integrations/microsoft/graph-client";
import { findLatestSentInConversation, replyToMessage, toNewEmail } from "@/integrations/microsoft/mail";
import { loadTokenSet } from "@/integrations/microsoft/token-store";
import { createSignedCopy, markSignedDocumentSent } from "@/documents/sign";
import type { Company, Settings } from "@/lib/config";
import type { ActionExecutor, ExecutionResult } from "../types";

const log = createLogger("executors.signing");

export interface SigningExecutorDeps {
  db?: Db;
  client?: GraphClient;
  now?: () => Date;
  settings?: Settings;
  companies?: Company[];
}

/**
 * Exécuteur `sign_document` — appelé UNIQUEMENT par l'Action Engine après
 * validation. Étapes : copie signée (idempotente) → réponse dans le thread avec
 * le seul PDF signé → statuts. Un échec Graph laisse la copie signée en place
 * pour un nouvel essai sans recréer de PDF.
 */
export function createSigningExecutor(d: SigningExecutorDeps = {}): ActionExecutor<"sign_document"> {
  return {
    type: "sign_document",
    async execute(payload, ctx): Promise<ExecutionResult> {
      const db = d.db ?? getDb();
      const client = d.client ?? createConnectedGraphClient({ db, userId: ctx.userId ?? undefined });
      const now = d.now ?? (() => new Date());
      const original = documentsRepo.getDocument(payload.document_id, db);
      if (!original) throw new EmaError("NOT_FOUND", `Document ${payload.document_id} introuvable`);
      const email = emailsRepo.getEmail(payload.email_id, db);
      if (!email) throw new EmaError("NOT_FOUND", `Email ${payload.email_id} introuvable`);

      const { document: signed, reused } = await createSignedCopy(payload, ctx.actionId, { db, settings: d.settings, companies: d.companies });
      if (reused) logHistory({ eventType: "document.signed_reused", message: "Copie signée existante réutilisée (nouvel essai d'envoi)", actor: "ema", actionId: ctx.actionId, emailId: email.id, documentId: signed.id }, db);

      // Pièce jointe : exclusivement le PDF signé (jamais signature.png, tampon ou autre fichier privé).
      const file = safeJoin(privateRoot(), signed.original_path);
      if (!fs.existsSync(file)) throw new EmaError("NOT_FOUND", "Copie signée absente du stockage privé");
      const attachment = { name: signed.name, contentType: "application/pdf", contentBytesBase64: fs.readFileSync(file).toString("base64") };
      const since = new Date(now().getTime() - 60_000).toISOString();
      await replyToMessage(client, email.graph_id, { comment: payload.reply_body, replyAll: false, attachments: [attachment] });

      let sentEmailId: string | null = null;
      try {
        const sent = email.thread_id ? await findLatestSentInConversation(client, email.thread_id, since) : null;
        if (sent) {
          const existing = emailsRepo.getEmailByGraphId(sent.id, db);
          sentEmailId = existing?.id ?? emailsRepo.insertEmail({ ...toNewEmail(sent, { accountEmail: loadTokenSet(db, ctx.userId ?? undefined)?.accountEmail ?? null, direction: "outbound", status: "PROCESSED" }), userId: ctx.userId }, db).id;
        }
      } catch (err) {
        log.warn("could not record sent signed reply", { message: err instanceof Error ? err.message : String(err) });
      }
      markSignedDocumentSent(original, signed, sentEmailId, db);
      logHistory({ eventType: "document.signed_sent", message: `Devis signé renvoyé à ${email.sender_email ?? "?"} (${signed.name})`, actor: "ema", actionId: ctx.actionId, emailId: email.id, documentId: signed.id, details: { sent_email_id: sentEmailId, attachment: signed.name } }, db);
      return { ok: true, summary: `Devis signé et renvoyé à ${email.sender_email ?? "?"}`, data: { signed_document_id: signed.id, sent_email_id: sentEmailId, reused_signed_copy: reused } };
    },
  };
}
