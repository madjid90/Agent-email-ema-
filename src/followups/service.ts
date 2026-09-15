import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as followupsRepo from "@/database/repositories/followups";
import * as emailsRepo from "@/database/repositories/emails";
import * as actionsRepo from "@/database/repositories/actions";
import { logHistory } from "@/database/repositories/history";
import type { EmailRow, FollowupKind, FollowupRow } from "@/database/types";
import { getSettings, type Company, type Contact, type Rule, type Settings } from "@/lib/config";
import { getApproverPhone, getEnv } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { nowIso } from "@/lib/ids";
import { createLogger } from "@/lib/logger";
import { formatDateTime } from "@/lib/time";
import { proposeAction } from "@/actions/engine";
import type { StructuredClient } from "@/integrations/anthropic/structured";
import { createConnectedGraphClient, isOutlookConnected, type GraphClient } from "@/integrations/microsoft/graph-client";
import { importConversation } from "@/integrations/microsoft/sync";
import { listConversation } from "@/integrations/microsoft/mail";
import { getWhatsappClient, isWhatsappConfigured, type WhatsappClient } from "@/integrations/whatsapp/client";
import { notifyPendingApproval } from "@/integrations/whatsapp/approvals";
import { reminderMessage, templateMessage, textMessage } from "@/integrations/whatsapp/messages";
import { OUTSIDE_WINDOW_CODES } from "@/integrations/whatsapp/types";
import { WhatsappError } from "@/integrations/whatsapp/client";
import { checkThread } from "./detect";
import { generateFollowupDraft } from "./draft";
import { resolveFollowupDate, type FollowupWhen } from "./schedule";

const log = createLogger("followups");

/** Client Graph injectable (tests) ; par défaut celui relié aux tokens stockés. */
let graphFactory: ((db: Db) => GraphClient) | null = null;
export function setFollowupGraphClientForTests(factory: ((db: Db) => GraphClient) | null): void {
  graphFactory = factory;
}

/** Nouvelle tentative après un échec de vérification Outlook. */
export const CHECK_RETRY_MINUTES = 15;
/** Une vérification bloquée plus longtemps (process interrompu) est reprise. */
export const STALE_CHECKING_MINUTES = 15;

export interface FollowupDeps {
  db?: Db;
  settings?: Settings;
  rules?: Rule[];
  companies?: Company[];
  contacts?: Contact[];
  /** Client Anthropic (brouillon). */
  client?: StructuredClient;
  model?: string;
  /** Client Graph ; `null` force le comportement « Outlook indisponible ». */
  graph?: GraphClient | null;
  whatsapp?: WhatsappClient;
  approverPhone?: string | null;
  now?: () => Date;
  actor?: string;
}

function resolve(deps: FollowupDeps): { db: Db; settings: Settings; now: Date } {
  return { db: deps.db ?? getDb(), settings: deps.settings ?? getSettings(), now: deps.now ? deps.now() : new Date() };
}

/* Programmation ---------------------------------------------------------- */

export interface ScheduleFollowupInput {
  emailId?: string | null;
  threadId?: string | null;
  when?: FollowupWhen | null;
  reason: string;
  kind?: FollowupKind;
  recipient?: string | null;
  companyId?: string | null;
  documentId?: string | null;
  title?: string | null;
  actionId?: string | null;
  createdBy?: string;
}

/**
 * Programme une relance ou un rappel interne. La date est calculée côté serveur
 * (jamais fournie par le modèle) et l'ancrage `watch_after` est le dernier
 * message sortant connu du thread : seules les réponses postérieures compteront.
 */
export function scheduleFollowup(input: ScheduleFollowupInput, deps: FollowupDeps = {}): FollowupRow {
  const { db, settings, now } = resolve(deps);
  const kind: FollowupKind = input.kind ?? "EXTERNAL_FOLLOWUP";
  const email = input.emailId ? emailsRepo.getEmail(input.emailId, db) : undefined;
  if (input.emailId && !email) throw new EmaError("NOT_FOUND", `Email ${input.emailId} introuvable`);
  const threadId = input.threadId ?? email?.thread_id ?? email?.id ?? null;
  if (!threadId && kind === "EXTERNAL_FOLLOWUP") throw new EmaError("VALIDATION", "Une relance externe doit être rattachée à un email ou à un thread");

  const executeAt = resolveFollowupDate(input.when, settings, now);
  const thread = threadId ? emailsRepo.listThread(threadId, db) : [];
  const lastOutbound = [...thread].reverse().find((e) => e.direction === "outbound");
  const watchAfter = lastOutbound?.received_at ?? email?.received_at ?? now.toISOString();
  const recipient = input.recipient ?? recipientFor(email, thread);

  const followup = followupsRepo.insertFollowup(
    {
      kind,
      threadId: threadId ?? `reminder:${input.emailId ?? input.documentId ?? nowIso()}`,
      emailId: email?.id ?? null,
      recipient,
      companyId: input.companyId ?? null,
      documentId: input.documentId ?? null,
      title: input.title ?? null,
      reason: input.reason,
      executeAt,
      watchAfter,
      maxAttempts: settings.followups.maxAttempts,
      actionId: input.actionId ?? null,
      createdBy: input.createdBy ?? deps.actor ?? "user",
    },
    db,
  );
  logHistory(
    {
      eventType: "followup.created",
      message: `${kind === "INTERNAL_REMINDER" ? "Rappel interne" : "Relance"} programmé${kind === "INTERNAL_REMINDER" ? "" : "e"} le ${formatDateTime(executeAt, settings.company.timezone)}${recipient ? ` — ${recipient}` : ""} : ${input.reason}`,
      actor: input.createdBy === "whatsapp" ? "whatsapp" : "user",
      followupId: followup.id,
      emailId: followup.email_id,
      details: { kind, executeAt, watchAfter },
    },
    db,
  );
  return followup;
}

function recipientFor(email: EmailRow | undefined, thread: EmailRow[]): string | null {
  if (email && email.direction === "inbound" && email.sender_email) return email.sender_email;
  const lastInbound = [...thread].reverse().find((e) => e.direction === "inbound" && e.sender_email);
  if (lastInbound?.sender_email) return lastInbound.sender_email;
  const lastOutbound = [...thread].reverse().find((e) => e.direction === "outbound");
  if (lastOutbound) {
    try {
      const to = JSON.parse(lastOutbound.to_recipients) as string[];
      return to[0] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/* Traitement des échéances ------------------------------------------------ */

export type FollowupOutcome =
  | "skipped"
  | "reminded"
  | "check_failed"
  | "response_received"
  | "auto_reply_postponed"
  | "review_required"
  | "superseded"
  | "max_attempts"
  | "draft_created"
  | "draft_reused"
  | "not_needed"
  | "failed"
  | "disabled";

export interface FollowupResult {
  followupId: string;
  outcome: FollowupOutcome;
  actionId: string | null;
  message: string;
}

/** Toutes les relances échues. Chaque relance est traitée isolément : une erreur n'arrête pas les autres. */
export async function processDueFollowups(deps: FollowupDeps = {}): Promise<FollowupResult[]> {
  const { db, settings, now } = resolve(deps);
  if (!settings.followups.enabled) return [];
  releaseStaleChecks(db, now);
  const results: FollowupResult[] = [];
  for (const f of followupsRepo.listDueFollowups(now.toISOString(), db)) {
    try {
      results.push(await processFollowup(f.id, deps));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("followup processing failed", { followupId: f.id, message });
      followupsRepo.transitionFollowup(f.id, ["CHECKING", "SCHEDULED", "CHECK_FAILED"], "FAILED", { last_error: message.slice(0, 300) }, db);
      logHistory({ eventType: "followup.failed", message: `Traitement de la relance impossible : ${message}`, actor: "system", followupId: f.id, emailId: f.email_id }, db);
      results.push({ followupId: f.id, outcome: "failed", actionId: null, message });
    }
  }
  return results;
}

/**
 * Reprise après interruption : une relance restée en CHECKING (worker tué entre
 * deux étapes) redevient traitable. La fenêtre évite de voler le travail d'un
 * autre worker encore actif.
 */
export function releaseStaleChecks(db: Db, now: Date): number {
  const cutoff = new Date(now.getTime() - STALE_CHECKING_MINUTES * 60_000).toISOString();
  let n = 0;
  for (const f of followupsRepo.listFollowups({ status: "CHECKING", limit: 100 }, db)) {
    if ((f.last_checked_at ?? f.created_at) > cutoff) continue;
    if (followupsRepo.transitionFollowup(f.id, "CHECKING", "SCHEDULED", {}, db)) {
      logHistory({ eventType: "followup.check_failed", message: "Vérification interrompue : relance remise en file", actor: "system", followupId: f.id, emailId: f.email_id }, db);
      n++;
    }
  }
  return n;
}

/**
 * Traite une relance échue. Ordre imposé : verrouillage atomique → vérification
 * Outlook réelle → détection de réponse → brouillon → action à valider.
 * Aucune relance n'est préparée sans avoir pu relire le thread.
 */
export async function processFollowup(followupId: string, deps: FollowupDeps = {}): Promise<FollowupResult> {
  const { db, settings, now } = resolve(deps);
  const existing = followupsRepo.getFollowup(followupId, db);
  if (!existing) throw new EmaError("NOT_FOUND", `Relance ${followupId} introuvable`);
  if (!settings.followups.enabled) return { followupId, outcome: "disabled", actionId: null, message: "Relances désactivées" };

  // Verrou : une seule exécution possible, même avec deux workers ou après un crash.
  if (!followupsRepo.transitionFollowup(followupId, ["SCHEDULED", "CHECK_FAILED"], "CHECKING", { last_checked_at: now.toISOString() }, db)) {
    return { followupId, outcome: "skipped", actionId: null, message: `Relance déjà en cours de traitement (${existing.status})` };
  }
  const followup = followupsRepo.getFollowup(followupId, db) as FollowupRow;

  if (followup.kind === "INTERNAL_REMINDER") return remind(followup, deps);

  // 1. Vérification Outlook obligatoire — jamais de supposition « pas de réponse ».
  const graph = deps.graph === undefined ? (graphFactory ? graphFactory(db) : isOutlookConnected(db) ? createConnectedGraphClient({ db }) : null) : deps.graph;
  if (!graph) return checkFailed(followup, "Outlook n'est pas connecté : vérification impossible", deps);
  let thread: EmailRow[];
  try {
    // Source de vérité : le thread réel dans Outlook, pas le cache SQLite.
    const remote = await listConversation(graph, followup.thread_id, 30);
    if (remote.length === 0) return checkFailed(followup, "Thread introuvable dans Outlook", deps);
    thread = await importConversation(graph, followup.thread_id, { db, max: 30 });
  } catch (err) {
    return checkFailed(followup, `Microsoft Graph indisponible : ${err instanceof Error ? err.message : String(err)}`, deps);
  }
  if (thread.length === 0) return checkFailed(followup, "Thread introuvable dans Outlook", deps);

  followupsRepo.updateFollowup(followup.id, { last_checked_at: now.toISOString(), last_error: null }, db);
  const check = checkThread(thread, followup);
  logHistory({ eventType: "followup.checked", message: `Thread vérifié (${check.consideredCount} message(s) depuis l'ancrage)`, actor: "worker", followupId: followup.id, emailId: followup.email_id }, db);

  // 2. Un message sortant plus récent rend la relance obsolète.
  if (check.newerOutbound) {
    followupsRepo.transitionFollowup(followup.id, "CHECKING", "SUPERSEDED", { completed_at: now.toISOString(), cancellation_reason: "Nouveau message envoyé manuellement dans le thread" }, db);
    logHistory({ eventType: "followup.superseded", message: "Relance obsolète : un message plus récent a été envoyé dans le thread", actor: "worker", followupId: followup.id, emailId: followup.email_id }, db);
    return { followupId, outcome: "superseded", actionId: null, message: "Message sortant plus récent" };
  }

  // 3. Réponse reçue.
  if (check.reply && check.classification === "HUMAN_REPLY") {
    followupsRepo.transitionFollowup(followup.id, "CHECKING", "RESPONSE_RECEIVED", { completed_at: now.toISOString(), last_reply_email_id: check.reply.id, cancellation_reason: "Réponse reçue" }, db);
    logHistory({ eventType: "followup.response_received", message: `Réponse reçue de ${check.reply.sender_name ?? check.reply.sender_email ?? "l'interlocuteur"} : relance annulée`, actor: "worker", followupId: followup.id, emailId: check.reply.id }, db);
    return { followupId, outcome: "response_received", actionId: null, message: "Réponse humaine détectée" };
  }
  if (check.reply && check.classification === "AUTO_REPLY") {
    const next = resolveFollowupDate({ in_days: settings.followups.autoReplyPostponeDays }, settings, now);
    followupsRepo.transitionFollowup(followup.id, "CHECKING", "SCHEDULED", { execute_at: next, last_reply_email_id: check.reply.id }, db);
    logHistory({ eventType: "followup.auto_reply_detected", message: `Réponse automatique détectée : relance reportée au ${formatDateTime(next, settings.company.timezone)}`, actor: "worker", followupId: followup.id, emailId: check.reply.id }, db);
    return { followupId, outcome: "auto_reply_postponed", actionId: null, message: "Réponse automatique" };
  }
  if (check.reply && check.classification === "AMBIGUOUS") {
    followupsRepo.transitionFollowup(followup.id, "CHECKING", "REVIEW_REQUIRED", { requires_human_review: 1, last_reply_email_id: check.reply.id }, db);
    logHistory({ eventType: "followup.review_required", message: "Réponse ambiguë (automatique ou humaine ?) : vérification humaine requise, aucune relance préparée", actor: "worker", followupId: followup.id, emailId: check.reply.id }, db);
    await notifyFollowup(followup.id, `⚠️ EMA — Relance à vérifier\n\n${followup.recipient ?? "L'interlocuteur"} a envoyé un message dont la nature est incertaine (réponse automatique ?).\n\nAucune relance n'a été préparée. Ouvrez EMA pour décider.`, deps);
    return { followupId, outcome: "review_required", actionId: null, message: "Réponse ambiguë" };
  }

  // 4. Nombre maximal de relances atteint.
  if (followup.attempts >= followup.max_attempts) {
    followupsRepo.transitionFollowup(followup.id, "CHECKING", "MAX_ATTEMPTS_REACHED", { completed_at: now.toISOString() }, db);
    logHistory({ eventType: "followup.max_attempts", message: `Aucune réponse après ${followup.attempts} relance(s) : suivi suspendu, décision humaine requise`, actor: "worker", followupId: followup.id, emailId: followup.email_id }, db);
    await notifyFollowup(
      followup.id,
      `⚠️ EMA — Suivi sans réponse\n\n${followup.recipient ?? "L'interlocuteur"} n'a pas répondu après ${followup.attempts} relance(s).\n\nSouhaites-tu préparer une nouvelle relance ou abandonner le suivi ? Réponds « relance-le » ou « annule la relance ».`,
      deps,
    );
    return { followupId, outcome: "max_attempts", actionId: null, message: "Nombre maximal de relances atteint" };
  }

  // 5. Brouillon (idempotent : une action en attente est réutilisée, jamais dupliquée).
  if (followup.generated_action_id) {
    const previous = actionsRepo.getAction(followup.generated_action_id, db);
    if (previous && (previous.status === "WAITING_APPROVAL" || previous.status === "PROPOSED")) {
      followupsRepo.transitionFollowup(followup.id, "CHECKING", "WAITING_APPROVAL", {}, db);
      return { followupId, outcome: "draft_reused", actionId: previous.id, message: "Brouillon déjà préparé" };
    }
  }
  logHistory({ eventType: "followup.due", message: "Échéance atteinte, aucune réponse : rédaction de la relance", actor: "worker", followupId: followup.id, emailId: followup.email_id }, db);

  let proposal;
  try {
    proposal = await generateFollowupDraft(followup, { db, settings, rules: deps.rules, companies: deps.companies, contacts: deps.contacts, client: deps.client, model: deps.model });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    followupsRepo.transitionFollowup(followup.id, "CHECKING", "FAILED", { last_error: message.slice(0, 300) }, db);
    logHistory({ eventType: "followup.failed", message: `Impossible de préparer la relance : ${message}`, actor: "system", followupId: followup.id, emailId: followup.email_id }, db);
    return { followupId, outcome: "failed", actionId: null, message };
  }
  if (!proposal.followup_needed) {
    followupsRepo.transitionFollowup(followup.id, "CHECKING", "REVIEW_REQUIRED", { requires_human_review: 1, last_error: null, cancellation_reason: proposal.reason.slice(0, 300) }, db);
    logHistory({ eventType: "followup.review_required", message: `Relance jugée inutile : ${proposal.reason}. Décision humaine requise.`, actor: "worker", followupId: followup.id, emailId: followup.email_id }, db);
    return { followupId, outcome: "not_needed", actionId: null, message: proposal.reason };
  }

  const anchor = anchorEmail(followup, thread, db);
  if (!anchor) return checkFailed(followup, "Aucun message du thread ne permet de répondre", deps);
  const sourceAction = followup.action_id ? actionsRepo.getAction(followup.action_id, db) : undefined;
  const financial = sourceAction?.type === "payment_request" || sourceAction?.type === "deposit_request";
  const action = proposeAction(
    {
      type: "reply_email",
      title: `Relance ${followup.attempts + 1}/${followup.max_attempts} — ${followup.recipient ?? anchor.subject}`,
      payload: { email_id: anchor.id, body: proposal.body, reply_all: false, attachments: [], followup_id: followup.id, attempt: followup.attempts + 1 },
      sourceEmailId: anchor.id,
      companyId: followup.company_id,
      // Une relance financière conserve le niveau de risque de l'action d'origine.
      riskLevel: financial ? "HIGH" : undefined,
      requiresApproval: true,
      actor: "ema",
    },
    { db, settings },
  );
  followupsRepo.transitionFollowup(followup.id, "CHECKING", "WAITING_APPROVAL", { generated_action_id: action.id, last_error: null, requires_human_review: proposal.requires_human_review ? 1 : 0 }, db);
  logHistory({ eventType: "followup.draft_created", message: `Relance rédigée (tentative ${followup.attempts + 1}/${followup.max_attempts}) : validation requise`, actor: "ema", followupId: followup.id, emailId: anchor.id, actionId: action.id, details: { confidence: proposal.confidence } }, db);
  await notifyPendingApproval(action.id, { db, settings, client: deps.whatsapp, approverPhone: deps.approverPhone });
  logHistory({ eventType: "followup.approval_requested", message: "Demande de validation envoyée pour la relance", actor: "ema", followupId: followup.id, actionId: action.id }, db);
  return { followupId, outcome: "draft_created", actionId: action.id, message: proposal.summary };
}

/** Message du thread auquel répondre : l'email d'origine, sinon le dernier message connu. */
function anchorEmail(followup: FollowupRow, thread: EmailRow[], db: Db): EmailRow | null {
  const original = followup.email_id ? emailsRepo.getEmail(followup.email_id, db) : undefined;
  if (original?.graph_id) return original;
  const withGraph = [...thread].reverse().find((e) => e.graph_id);
  return withGraph ?? null;
}

function checkFailed(followup: FollowupRow, message: string, deps: FollowupDeps): FollowupResult {
  const { db, settings, now } = resolve(deps);
  const retryAt = new Date(now.getTime() + CHECK_RETRY_MINUTES * 60_000).toISOString();
  followupsRepo.transitionFollowup(followup.id, "CHECKING", "CHECK_FAILED", { execute_at: retryAt, last_error: message.slice(0, 300), last_checked_at: now.toISOString() }, db);
  logHistory({ eventType: "followup.check_failed", message: `Vérification impossible, aucune relance envoyée : ${message}. Nouvelle tentative le ${formatDateTime(retryAt, settings.company.timezone)}`, actor: "system", followupId: followup.id, emailId: followup.email_id }, db);
  return { followupId: followup.id, outcome: "check_failed", actionId: null, message };
}

/* Rappels internes -------------------------------------------------------- */

async function remind(followup: FollowupRow, deps: FollowupDeps): Promise<FollowupResult> {
  const { db, now } = resolve(deps);
  followupsRepo.transitionFollowup(followup.id, "CHECKING", "REMINDED", { last_checked_at: now.toISOString() }, db);
  logHistory({ eventType: "followup.due", message: `Rappel interne échu : ${followup.title ?? followup.reason}`, actor: "worker", followupId: followup.id, emailId: followup.email_id }, db);
  const sent = await sendNotification(followup.id, { reminder: { title: followup.title ?? followup.reason, detail: followup.reason } }, deps);
  return { followupId: followup.id, outcome: "reminded", actionId: null, message: sent ? "Rappel envoyé" : "Rappel en attente de notification" };
}

/* Notifications proactives ------------------------------------------------ */

interface NotificationPayload {
  text?: string;
  reminder?: { title: string; detail: string };
}

/**
 * Notification WhatsApp proactive (rappel, suivi sans réponse, réponse ambiguë).
 * Une notification déjà envoyée n'est jamais renvoyée. Si Meta refuse le message
 * libre (fenêtre de 24 h fermée) et qu'un template est configuré, le template
 * est utilisé ; sinon la notification reste `notification_pending` et n'est
 * JAMAIS considérée comme envoyée.
 */
export async function notifyFollowup(followupId: string, text: string, deps: FollowupDeps = {}): Promise<boolean> {
  return sendNotification(followupId, { text }, deps);
}

async function sendNotification(followupId: string, payload: NotificationPayload, deps: FollowupDeps): Promise<boolean> {
  const { db } = resolve(deps);
  const followup = followupsRepo.getFollowup(followupId, db);
  if (!followup) return false;
  if (followup.notified_at) return true; // dédoublonnage : une seule notification par échéance
  const approver = deps.approverPhone === undefined ? getApproverPhone() : deps.approverPhone;
  const client = deps.whatsapp ?? (isWhatsappConfigured() ? getWhatsappClient() : null);
  const markPending = (reason: string): boolean => {
    followupsRepo.updateFollowup(followupId, { notification_pending: 1, notify_attempts: followup.notify_attempts + 1, last_error: reason.slice(0, 300) }, db);
    logHistory({ eventType: "followup.notification_pending", message: `Notification WhatsApp non envoyée (${reason}) : visible dans l'interface`, actor: "system", followupId, emailId: followup.email_id }, db);
    return false;
  };
  if (!client || !approver) return markPending(client ? "numéro autorisé absent" : "WhatsApp non configuré");

  const message = payload.reminder ? reminderMessage(approver, followupId, payload.reminder.title, payload.reminder.detail) : textMessage(approver, payload.text ?? "");
  try {
    await client.send(message);
  } catch (err) {
    const outsideWindow = err instanceof WhatsappError && err.metaCode !== null && (OUTSIDE_WINDOW_CODES as readonly number[]).includes(err.metaCode);
    const env = getEnv();
    if (outsideWindow && env.WHATSAPP_FOLLOWUP_TEMPLATE_NAME) {
      try {
        await client.send(templateMessage(approver, env.WHATSAPP_FOLLOWUP_TEMPLATE_NAME, env.WHATSAPP_FOLLOWUP_TEMPLATE_LANG, []));
        followupsRepo.updateFollowup(followupId, { notification_pending: 0, notified_at: nowIso(), notify_attempts: followup.notify_attempts + 1 }, db);
        logHistory({ eventType: "followup.notified", message: "Notification envoyée via le template WhatsApp (fenêtre de 24 h fermée)", actor: "ema", followupId, emailId: followup.email_id }, db);
        return true;
      } catch (templateErr) {
        return markPending(`template refusé : ${templateErr instanceof Error ? templateErr.message : String(templateErr)}`);
      }
    }
    return markPending(err instanceof Error ? err.message : String(err));
  }
  followupsRepo.updateFollowup(followupId, { notification_pending: 0, notified_at: nowIso(), notify_attempts: followup.notify_attempts + 1 }, db);
  logHistory({ eventType: "followup.notified", message: "Notification WhatsApp envoyée", actor: "ema", followupId, emailId: followup.email_id }, db);
  return true;
}

/* Réconciliation avec l'Action Engine ------------------------------------- */

/**
 * Aligne les relances en attente sur l'état réel de leur action.
 * Exécutée → SENT (tentative suivante, nouvel ancrage) ; refusée → CANCELLED ;
 * échouée → la relance reste en attente (nouvelle tentative possible).
 * Idempotent : relancer la réconciliation ne produit aucun doublon.
 */
export function reconcileFollowups(deps: FollowupDeps = {}): FollowupResult[] {
  const { db, now } = resolve(deps);
  const results: FollowupResult[] = [];
  for (const f of followupsRepo.listFollowups({ status: "WAITING_APPROVAL", limit: 100 }, db)) {
    if (!f.generated_action_id) continue;
    const action = actionsRepo.getAction(f.generated_action_id, db);
    if (!action) continue;
    if (action.status === "COMPLETED") {
      if (followupsRepo.transitionFollowup(f.id, "WAITING_APPROVAL", "SENT", { attempts: f.attempts + 1, watch_after: now.toISOString(), completed_at: now.toISOString() }, db)) {
        logHistory({ eventType: "followup.sent", message: `Relance envoyée (tentative ${f.attempts + 1}/${f.max_attempts})`, actor: "ema", followupId: f.id, emailId: f.email_id, actionId: action.id }, db);
        results.push({ followupId: f.id, outcome: "draft_created", actionId: action.id, message: "Relance envoyée" });
      }
    } else if (action.status === "REJECTED") {
      if (followupsRepo.transitionFollowup(f.id, "WAITING_APPROVAL", "CANCELLED", { cancelled_at: now.toISOString(), cancellation_reason: "Relance refusée" }, db)) {
        logHistory({ eventType: "followup.cancelled", message: "Relance refusée : aucun email envoyé", actor: "user", followupId: f.id, emailId: f.email_id, actionId: action.id }, db);
        results.push({ followupId: f.id, outcome: "skipped", actionId: action.id, message: "Relance refusée" });
      }
    }
  }
  return results;
}

/* Report / annulation ----------------------------------------------------- */

export function postponeFollowup(followupId: string, when: FollowupWhen | null | undefined, deps: FollowupDeps = {}): FollowupRow {
  const { db, settings, now } = resolve(deps);
  const followup = followupsRepo.getFollowup(followupId, db);
  if (!followup) throw new EmaError("NOT_FOUND", `Relance ${followupId} introuvable`);
  const executeAt = resolveFollowupDate(when, settings, now);
  if (!followupsRepo.rescheduleFollowup(followupId, executeAt, db)) throw new EmaError("INVALID_TRANSITION", `Relance en statut ${followup.status} : report impossible`);
  logHistory({ eventType: "followup.snoozed", message: `Relance reportée au ${formatDateTime(executeAt, settings.company.timezone)}`, actor: deps.actor === "whatsapp" ? "whatsapp" : "user", followupId, emailId: followup.email_id }, db);
  return followupsRepo.getFollowup(followupId, db) as FollowupRow;
}

export function cancelFollowup(followupId: string, reason: string, deps: FollowupDeps = {}): FollowupRow {
  const { db } = resolve(deps);
  const followup = followupsRepo.getFollowup(followupId, db);
  if (!followup) throw new EmaError("NOT_FOUND", `Relance ${followupId} introuvable`);
  if (!followupsRepo.cancelFollowup(followupId, reason, db)) throw new EmaError("INVALID_TRANSITION", `Relance en statut ${followup.status} : annulation impossible`);
  logHistory({ eventType: "followup.cancelled", message: `Relance annulée : ${reason}`, actor: deps.actor === "whatsapp" ? "whatsapp" : "user", followupId, emailId: followup.email_id }, db);
  return followupsRepo.getFollowup(followupId, db) as FollowupRow;
}

/** Rappel interne marqué comme traité. */
export function completeReminder(followupId: string, deps: FollowupDeps = {}): FollowupRow {
  const { db, now } = resolve(deps);
  const followup = followupsRepo.getFollowup(followupId, db);
  if (!followup) throw new EmaError("NOT_FOUND", `Relance ${followupId} introuvable`);
  if (!followupsRepo.transitionFollowup(followupId, ["REMINDED", "SCHEDULED"], "DONE", { completed_at: now.toISOString() }, db)) {
    throw new EmaError("INVALID_TRANSITION", `Rappel en statut ${followup.status}`);
  }
  logHistory({ eventType: "followup.done", message: "Rappel marqué comme traité", actor: deps.actor === "whatsapp" ? "whatsapp" : "user", followupId, emailId: followup.email_id }, db);
  return followupsRepo.getFollowup(followupId, db) as FollowupRow;
}
