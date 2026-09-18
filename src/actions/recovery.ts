import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as actionsRepo from "@/database/repositories/actions";
import * as emailsRepo from "@/database/repositories/emails";
import * as documentsRepo from "@/database/repositories/documents";
import { logHistory } from "@/database/repositories/history";
import type { ActionRow } from "@/database/types";
import { parseJson } from "@/database/types";
import { getSettings, type Settings } from "@/lib/config";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { createConnectedGraphClient, isOutlookConnected, type GraphClient } from "@/integrations/microsoft/graph-client";
import { reconcileSentMessage, type ReconcileResult } from "@/integrations/microsoft/reconcile";
import { executeAction } from "./engine";

/**
 * Reprise après interruption et réconciliation Outlook (phase 8A).
 *
 * Deux règles absolues :
 * 1. On ne renvoie jamais un email dont le sort est inconnu : on cherche d'abord
 *    la trace réelle dans les éléments envoyés.
 * 2. En cas de doute persistant, on s'arrête et on demande une vérification
 *    humaine — jamais un second envoi « au cas où ».
 */
const log = createLogger("actions.recovery");

export const AMBIGUOUS_CODE = "DELIVERY_AMBIGUOUS";
export const AMBIGUOUS_MESSAGE =
  "Impossible de déterminer avec certitude si Microsoft a envoyé le message. Vérification humaine requise avant une nouvelle tentative.";

/** Actions dont l'exécution envoie un email (donc non rejouables à l'aveugle). */
export const SENDING_ACTION_TYPES = ["reply_email", "forward_email", "send_email", "payment_request", "deposit_request", "send_followup", "sign_document"] as const;

export function isSendingAction(type: string): boolean {
  return (SENDING_ACTION_TYPES as readonly string[]).includes(type);
}

export interface RecoveryDeps {
  db?: Db;
  settings?: Settings;
  /** Client Graph ; `null` = Outlook indisponible (aucune conclusion possible). */
  client?: GraphClient | null;
  now?: () => Date;
}

function resolve(deps: RecoveryDeps): { db: Db; settings: Settings; now: Date } {
  return { db: deps.db ?? getDb(), settings: deps.settings ?? getSettings(), now: deps.now ? deps.now() : new Date() };
}

function graphOf(deps: RecoveryDeps, db: Db, userId: string | null): GraphClient | null {
  if (deps.client !== undefined) return deps.client;
  return isOutlookConnected(db, userId ?? undefined) ? createConnectedGraphClient({ db, userId: userId ?? undefined }) : null;
}

/** Fenêtre de recherche : un peu avant le début d'exécution. */
function searchSince(action: ActionRow): string {
  const base = action.executed_at ?? action.approved_at ?? action.created_at;
  return new Date(new Date(base).getTime() - 2 * 60_000).toISOString();
}

/** Nom du fichier réellement joint à l'envoi d'un devis signé, si connu. */
function signedAttachmentName(action: ActionRow, db: Db): string | null {
  if (!action.document_id) return null;
  const doc = documentsRepo.getDocument(action.document_id, db);
  if (!doc) return null;
  const signed = doc.signed_document_id ? documentsRepo.getDocument(doc.signed_document_id, db) : null;
  const name = signed?.name ?? doc.name;
  // L'exécuteur renomme la copie signée « <nom>-signe.pdf » au moment de l'envoi.
  return signed && !/-signe\.pdf$/i.test(name) ? `${name.replace(/\.pdf$/i, "")}-signe.pdf` : name;
}

/**
 * Cherche la trace réelle de l'envoi correspondant à une action.
 *
 * La conversation n'est jamais une preuve à elle seule (phase 8A.1) : selon le
 * type d'action, on exige aussi le destinataire attendu, le contenu réellement
 * préparé et/ou la pièce jointe signée. À défaut de correspondance complète, le
 * verdict est `unknown` — jamais un faux `sent`, jamais un second envoi.
 */
export async function reconcileAction(action: ActionRow, deps: RecoveryDeps = {}): Promise<ReconcileResult> {
  const { db } = resolve(deps);
  const client = graphOf(deps, db, action.user_id);
  if (!client) return { verdict: "unknown", message: null, detail: "Outlook n'est pas connecté : vérification impossible" };
  const payload = parseJson<Record<string, unknown>>(action.payload, {});
  const since = searchSince(action);
  const text = (key: string): string | null => (typeof payload[key] === "string" ? (payload[key] as string) : null);

  const emailId = typeof payload.email_id === "string" ? payload.email_id : action.source_email_id;
  const sourceEmail = emailId ? emailsRepo.getEmail(emailId, db) : null;
  const conversationId = sourceEmail?.thread_id ?? null;
  const payloadTo = Array.isArray(payload.to) ? (payload.to as string[]) : [];

  if (action.type === "reply_email" || action.type === "send_followup") {
    // Réponse dans le thread : contenu préparé + destinataire d'origine quand il est connu.
    const replyTo = sourceEmail?.sender_email ? [sourceEmail.sender_email] : [];
    return reconcileSentMessage(client, { conversationId, to: replyTo, bodyContains: text("body") ?? text("reply_body"), since });
  }
  if (action.type === "forward_email") {
    return reconcileSentMessage(client, { conversationId, to: payloadTo, since });
  }
  if (action.type === "sign_document") {
    // Le devis signé doit être joint au message envoyé (métadonnées lisibles avec Mail.Read).
    return reconcileSentMessage(client, {
      conversationId,
      bodyContains: text("reply_body"),
      attachmentName: signedAttachmentName(action, db),
      expectAttachment: true,
      since,
    });
  }
  // Nouvel email (paiement, acompte, envoi direct) : objet ET destinataire, plus le contenu si disponible.
  return reconcileSentMessage(client, { subject: text("subject"), to: payloadTo, bodyContains: text("body"), since });
}

export interface AmbiguityOutcome {
  action: ActionRow;
  verdict: ReconcileResult["verdict"];
  detail: string;
}

/**
 * Applique le verdict à une action dont l'envoi est incertain :
 * envoyé → COMPLETED sans renvoi ; non envoyé → l'action reste rejouable ;
 * inconnu → FAILED avec demande de vérification humaine.
 */
export async function resolveAmbiguousAction(actionId: string, deps: RecoveryDeps = {}): Promise<AmbiguityOutcome> {
  const { db, now } = resolve(deps);
  const action = actionsRepo.getAction(actionId, db);
  if (!action) throw new EmaError("NOT_FOUND", `Action ${actionId} introuvable`);
  const result = await reconcileAction(action, deps);

  if (result.verdict === "sent") {
    const from = action.status;
    actionsRepo.transitionAction(actionId, [from], "COMPLETED", { completed_at: now.toISOString(), error: null, error_code: null, result: JSON.stringify({ reconciled: true, detail: result.detail }) }, db);
    logHistory({ eventType: "action.reconciled", message: `Envoi confirmé dans les éléments envoyés — aucun second envoi (${result.detail})`, actor: "system", actionId, emailId: action.source_email_id }, db);
    return { action: actionsRepo.getAction(actionId, db) as ActionRow, verdict: result.verdict, detail: result.detail };
  }
  if (result.verdict === "unknown") {
    actionsRepo.transitionAction(actionId, [action.status], "FAILED", { completed_at: now.toISOString(), error: `${AMBIGUOUS_MESSAGE} (${result.detail})`, error_code: AMBIGUOUS_CODE }, db);
    logHistory({ eventType: "action.ambiguous", message: `${AMBIGUOUS_MESSAGE} (${result.detail})`, actor: "system", actionId, emailId: action.source_email_id }, db);
    return { action: actionsRepo.getAction(actionId, db) as ActionRow, verdict: result.verdict, detail: result.detail };
  }
  actionsRepo.transitionAction(actionId, [action.status], "FAILED", { completed_at: now.toISOString(), error: `Envoi non effectué : ${result.detail}`, error_code: "NOT_SENT" }, db);
  logHistory({ eventType: "action.failed", message: `Envoi non effectué (${result.detail}) : nouvelle tentative possible`, actor: "system", actionId, emailId: action.source_email_id }, db);
  return { action: actionsRepo.getAction(actionId, db) as ActionRow, verdict: result.verdict, detail: result.detail };
}

export interface RecoveryReport {
  resumed: string[];
  reconciled: string[];
  ambiguous: string[];
  skipped: string[];
}

/** Au-delà de ce délai, une action APPROVED ou EXECUTING est considérée interrompue. */
export const STALE_ACTION_MINUTES = 10;

/**
 * Tâche de reprise : une action validée mais jamais exécutée repart ; une action
 * interrompue en cours d'exécution est réconciliée, jamais rejouée à l'aveugle.
 */
export async function recoverStaleActions(deps: RecoveryDeps = {}): Promise<RecoveryReport> {
  const { db, now } = resolve(deps);
  const cutoff = new Date(now.getTime() - STALE_ACTION_MINUTES * 60_000).toISOString();
  const report: RecoveryReport = { resumed: [], reconciled: [], ambiguous: [], skipped: [] };

  // 1. Validée, jamais exécutée : aucun effet de bord n'a commencé, on exécute.
  for (const action of actionsRepo.listStaleActions("APPROVED", cutoff, db)) {
    if (action.executed_at) continue;
    logHistory({ eventType: "action.recovered", message: "Action validée non exécutée (interruption) : reprise", actor: "system", actionId: action.id, emailId: action.source_email_id }, db);
    try {
      await executeAction(action.id, { db, settings: deps.settings });
      report.resumed.push(action.id);
    } catch (err) {
      log.warn("resume failed", { actionId: action.id, message: err instanceof Error ? err.message : String(err) });
      report.skipped.push(action.id);
    }
  }

  // 2. Interrompue pendant l'exécution : on ne rejoue jamais un envoi sans vérifier.
  for (const action of actionsRepo.listStaleActions("EXECUTING", cutoff, db)) {
    if (!isSendingAction(action.type)) {
      actionsRepo.transitionAction(action.id, "EXECUTING", "FAILED", { completed_at: now.toISOString(), error: "Exécution interrompue", error_code: "INTERRUPTED" }, db);
      report.skipped.push(action.id);
      continue;
    }
    // Un devis déjà signé n'est jamais re-signé : la copie existante fait foi.
    if (action.type === "sign_document" && action.document_id) {
      const doc = documentsRepo.getDocument(action.document_id, db);
      if (doc?.signed_document_id) {
        logHistory({ eventType: "action.recovered", message: "Copie signée déjà créée : aucune seconde signature, vérification de l'envoi", actor: "system", actionId: action.id, documentId: doc.id, emailId: action.source_email_id }, db);
      }
    }
    const outcome = await resolveAmbiguousAction(action.id, deps);
    if (outcome.verdict === "sent") report.reconciled.push(action.id);
    else if (outcome.verdict === "unknown") report.ambiguous.push(action.id);
    else report.skipped.push(action.id);
  }
  return report;
}
