import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as actionsRepo from "@/database/repositories/actions";
import * as approvalsRepo from "@/database/repositories/approvals";
import * as chatRepo from "@/database/repositories/chat";
import { logHistory } from "@/database/repositories/history";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from "@/database/repositories/webhook-events";
import type { ActionRow } from "@/database/types";
import { getEnv } from "@/lib/env";
import { normalizePhone } from "@/lib/phone";
import { getUserByPhone, markPhoneVerified } from "@/database/repositories/users";
import { hitRateLimit } from "@/security/rate-limit";
import { isOutlookConnected } from "@/integrations/microsoft/graph-client";
import { getSettings, type Settings } from "@/lib/config";
import { formatDateTime } from "@/lib/time";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { approveAndExecute, rejectAction } from "@/actions/engine";
import type { StructuredClient } from "@/integrations/anthropic/structured";
import { lastRefs, numberRefs, parseOrdinal } from "@/agent/references";
import { runWhatsappAssistantTurn } from "@/agent/whatsapp-assistant";
import { getWhatsappClient, isWhatsappConfigured, type WhatsappClient } from "./client";
import { textMessage } from "./messages";
import { handleInboundEvent, maskPhone, notifyPendingApproval } from "./approvals";
import { parseButtonId, parseReminderButtonId } from "./webhook";
import { completeReminder, postponeFollowup } from "@/followups/service";
import { getFollowup } from "@/database/repositories/followups";
import type { WhatsappInboundEvent } from "./types";

const log = createLogger("whatsapp.router");

/**
 * Routeur WhatsApp (phase 6) : point d'entrée unique des événements entrants.
 * Il ne remplace rien — les boutons continuent d'être traités par le service
 * d'approbations (phase 3) — il ajoute le routage des messages texte vers
 * l'assistant conversationnel.
 *
 * Ordre invariant : numéro autorisé → dédoublonnage → routage. Rien n'est
 * envoyé à Claude avant ces deux contrôles.
 */
export type WhatsappRoute = "APPROVAL_INTERACTION" | "REMINDER_INTERACTION" | "CHAT_MESSAGE" | "IGNORED";

export interface RouterDeps {
  db?: Db;
  settings?: Settings;
  client?: WhatsappClient;
  anthropic?: StructuredClient;
  model?: string;
  /**
   * Numéro explicitement autorisé (tests, instance mono-utilisateur historique).
   * Non fourni : l'expéditeur est identifié par la table `users` (numéro E.164
   * vérifié) — c'est le mode de production.
   */
  approverPhone?: string | null;
  /** Utilisateur associé au numéro explicite ci-dessus (tests). */
  userId?: string | null;
  assistantEnabled?: boolean;
}

export interface RouterResult {
  route: WhatsappRoute;
  outcome: string;
  actionIds: string[];
  reply: string | null;
}

export const NO_LLM_REPLY = "Je n'ai pas pu traiter ta demande. Aucun email ni document n'a été modifié.";
/** Numéro inconnu : aucune donnée, aucun appel Microsoft, seulement l'invitation à activer WhatsApp depuis l'espace EMA. */
export const UNKNOWN_NUMBER_REPLY = "Ce numéro n'est pas encore associé à un compte EMA. Connectez-vous à votre espace EMA (Paramètres → Connexions → WhatsApp) pour activer WhatsApp.";
export const DISABLED_REPLY = "WhatsApp est désactivé pour votre compte EMA. Réactivez-le depuis Paramètres → Connexions → WhatsApp.";
/** Réponses d'onboarding limitées par numéro : un inconnu ne peut pas faire boucler EMA. */
const UNKNOWN_REPLY_LIMIT = { max: 3, windowMs: 60 * 60_000, blockMs: 60 * 60_000 };

/** Identité de l'expéditeur, résolue côté serveur avant toute lecture de données. */
export type SenderIdentity =
  | { kind: "user"; userId: string | null; phone: string; name: string | null }
  | { kind: "activation"; userId: string; phone: string; name: string | null }
  | { kind: "disabled"; userId: string; phone: string }
  | { kind: "unknown"; phone: string };

/**
 * numéro WhatsApp (chiffres) → utilisateur EMA. Ordre : numéro explicite injecté
 * (tests / instance historique) sinon table `users` sur le numéro E.164 normalisé.
 * Un numéro en attente de vérification déclenche l'activation ; un numéro inconnu
 * n'obtient rien d'autre qu'un message d'onboarding.
 */
export function identifySender(from: string, deps: RouterDeps, db: Db): SenderIdentity {
  if (deps.approverPhone !== undefined) {
    return deps.approverPhone && from === deps.approverPhone ? { kind: "user", userId: deps.userId ?? null, phone: from, name: null } : { kind: "unknown", phone: from };
  }
  const e164 = normalizePhone(from);
  const user = e164 ? getUserByPhone(e164, db) : undefined;
  if (!user) return { kind: "unknown", phone: from };
  if (user.phone_verified !== 1) return { kind: "activation", userId: user.id, phone: from, name: user.name };
  if (user.whatsapp_enabled !== 1) return { kind: "disabled", userId: user.id, phone: from };
  return { kind: "user", userId: user.id, phone: from, name: user.name };
}

/** Classement d'un événement entrant, sans effet de bord. */
export function classifyEvent(event: WhatsappInboundEvent): WhatsappRoute {
  if (parseButtonId(event.buttonId)) return "APPROVAL_INTERACTION";
  if (parseReminderButtonId(event.buttonId)) return "REMINDER_INTERACTION";
  if (event.kind === "text" && (event.text ?? "").trim().length > 0) return "CHAT_MESSAGE";
  return "IGNORED";
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const APPROVE_RE = /^(oui|ok|okay|dac|daccord|d accord|parfait|super|go|vas y|c est bon|cest bon|c est ok|je valide|valide|valider|valide le|valide la|valide ca|confirme|je confirme|envoie|envoie le|envoie la|envoie ca|envoie le mail|envoyer|tu peux envoyer|oui envoie|ok envoie|oui valide|ok valide|valide et envoie|oui c est bon|parfait envoie)$/;
const REJECT_RE = /^(non|nope|annule|annule ca|annuler|refuse|refuser|je refuse|laisse tomber|stop|surtout pas|n envoie pas|ne pas envoyer|pas maintenant|annule l action|annule tout)$/;

/**
 * Validation ou refus formulé en langage naturel. Volontairement strict :
 * la phrase entière doit être une formule de décision. « Envoie un mail à
 * Christophe » n'est pas une validation.
 */
export function parseNaturalDecision(text: string): "approve" | "reject" | null {
  const clean = normalize(text);
  if (!clean || clean.split(" ").length > 4) return null;
  if (APPROVE_RE.test(clean)) return "approve";
  if (REJECT_RE.test(clean)) return "reject";
  return null;
}

function pendingActions(db: Db, userId: string | null): ActionRow[] {
  return actionsRepo.listActions({ status: ["WAITING_APPROVAL"], limit: 20, userId: userId ?? undefined }, db);
}

function confirmation(action: ActionRow): string {
  if (action.status === "COMPLETED") return `✅ Fait : ${action.title}.`;
  if (action.status === "FAILED") return `❌ L'envoi a échoué : ${action.error ?? "erreur inconnue"}.\nAucune seconde exécution n'a été effectuée. Réponds « réessaie » ou relance depuis l'interface EMA.`;
  return `ℹ️ ${action.title} — statut : ${action.status}.`;
}

async function send(deps: RouterDeps, to: string, body: string): Promise<void> {
  try {
    const client = deps.client ?? (isWhatsappConfigured() ? getWhatsappClient() : null);
    if (client) await client.send(textMessage(to, body));
  } catch (err) {
    log.warn("whatsapp reply failed", { message: err instanceof Error ? err.message : String(err) });
  }
}

/** Décision naturelle appliquée à une action précise, via l'Action Engine. */
async function decide(actionId: string, decision: "approve" | "reject", approver: string, deps: RouterDeps, userId: string | null): Promise<RouterResult> {
  const db = deps.db ?? getDb();
  const decidedBy = `whatsapp:${maskPhone(approver)}`;
  const action = actionsRepo.getAction(actionId, db);
  if (userId && action && action.user_id !== userId) {
    await send(deps, approver, "⚠️ Action introuvable.");
    return { route: "CHAT_MESSAGE", outcome: "unauthorized", actionIds: [], reply: null };
  }
  try {
    if (decision === "reject") {
      const rejected = rejectAction(actionId, decidedBy, "Refusé sur WhatsApp", { db, settings: deps.settings });
      await send(deps, approver, `❌ Action refusée : ${rejected.title}. Aucun email envoyé.`);
      return { route: "CHAT_MESSAGE", outcome: "rejected", actionIds: [actionId], reply: null };
    }
    const result = await approveAndExecute(actionId, decidedBy, { db, settings: deps.settings });
    await send(deps, approver, confirmation(result));
    return { route: "CHAT_MESSAGE", outcome: result.status === "COMPLETED" ? "approved" : "failed", actionIds: [actionId], reply: null };
  } catch (err) {
    const message = err instanceof EmaError && err.code === "CONFLICT" ? "ℹ️ Cette action a déjà été traitée." : `⚠️ ${err instanceof Error ? err.message : "Erreur"}`;
    await send(deps, approver, message);
    return { route: "CHAT_MESSAGE", outcome: "already_decided", actionIds: [actionId], reply: null };
  }
}

/** Liste numérotée mémorisée : « Quelle action souhaites-tu valider ? ». */
async function askWhichAction(actions: ActionRow[], decision: "approve" | "reject", approver: string, deps: RouterDeps, userId: string | null): Promise<RouterResult> {
  const db = deps.db ?? getDb();
  const refs = numberRefs(actions.map((a) => ({ kind: "action" as const, id: a.id, label: a.title, pendingDecision: decision })));
  const body = [`${decision === "approve" ? "Quelle action souhaites-tu valider" : "Quelle action souhaites-tu refuser"} ?`, "", ...refs.map((r) => `${r.index}. ${r.label}`), "", "Réponds par le numéro (ex. « 1 »)."].join("\n");
  chatRepo.insertMessage({ userId, role: "assistant", content: body, channel: "WHATSAPP", refs }, db);
  await send(deps, approver, body);
  return { route: "CHAT_MESSAGE", outcome: "clarification", actionIds: [], reply: body };
}

/**
 * Pipeline complet d'un événement WhatsApp entrant.
 * 1. numéro autorisé, 2. dédoublonnage, 3. boutons → approbations,
 * 4. texte → décision naturelle puis assistant conversationnel.
 */
export async function handleWhatsappEvent(event: WhatsappInboundEvent, deps: RouterDeps = {}): Promise<RouterResult> {
  const db = deps.db ?? getDb();
  const settings = deps.settings ?? getSettings();
  const route = classifyEvent(event);

  // 1. Identification de l'expéditeur — avant toute lecture de données, tout
  //    appel à Claude, tout appel Microsoft, toute action.
  const identity = identifySender(event.from, deps, db);
  const masked = maskPhone(event.from);
  if (identity.kind === "unknown") {
    log.warn("whatsapp message from unknown number", { from: masked, route, code: "UNKNOWN_USER" });
    logHistory({ eventType: "whatsapp.unknown_number", message: `Message WhatsApp d'un numéro inconnu (${masked}) : ignoré, onboarding envoyé`, actor: "system" }, db);
    // Réponse d'onboarding bornée : jamais de boucle avec un inconnu, jamais de donnée.
    if (hitRateLimit(`wa-unknown:${masked}`, UNKNOWN_REPLY_LIMIT, Date.now(), db).allowed && route !== "IGNORED") await send(deps, event.from, UNKNOWN_NUMBER_REPLY);
    return { route: "IGNORED", outcome: "unknown_user", actionIds: [], reply: null };
  }
  if (identity.kind === "activation") {
    // Premier message depuis le numéro renseigné dans l'espace EMA : association définitive.
    const claimed = claimWebhookEvent({ provider: "whatsapp", externalId: event.messageId, eventType: "activation", sender: masked }, db);
    if (!claimed.claimed) return { route: "IGNORED", outcome: "duplicate", actionIds: [], reply: null };
    const user = markPhoneVerified(identity.userId, db);
    logHistory({ eventType: "whatsapp.activated", message: `WhatsApp activé pour ${user.email} (${masked})`, actor: "user", userId: user.id }, db);
    log.info("whatsapp activated", { userId: user.id, from: masked });
    const outlook = isOutlookConnected(db, user.id);
    const welcome = [
      `✅ WhatsApp activé${user.name ? `, ${user.name}` : ""} ! Je suis EMA, votre assistant email.`,
      outlook ? "Vous pouvez me demander par exemple : « Quels sont mes emails importants ? » ou « Recherche l'email de Julien concernant le devis »." : "Pour commencer, connectez votre boîte Outlook depuis votre espace EMA (Paramètres → Connexions).",
    ].join("\n\n");
    await send(deps, event.from, welcome);
    completeWebhookEvent("whatsapp", event.messageId, "activated", db);
    return { route: "IGNORED", outcome: "activated", actionIds: [], reply: welcome };
  }
  if (identity.kind === "disabled") {
    log.info("whatsapp message from disabled user ignored", { userId: identity.userId, from: masked });
    if (hitRateLimit(`wa-disabled:${identity.userId}`, UNKNOWN_REPLY_LIMIT, Date.now(), db).allowed) await send(deps, event.from, DISABLED_REPLY);
    return { route: "IGNORED", outcome: "disabled", actionIds: [], reply: null };
  }
  const approver = identity.phone;
  const userId = identity.userId;
  log.info("whatsapp message identified", { userId, from: masked, route });

  if (route === "APPROVAL_INTERACTION") {
    const r = await handleInboundEvent(event, { db, settings, client: deps.client, approverPhone: approver, userId });
    return { route, outcome: r.outcome, actionIds: r.actionId ? [r.actionId] : [], reply: null };
  }
  // Boutons d'un rappel interne : terminé / reporter. Aucun email n'est impliqué.
  if (route === "REMINDER_INTERACTION") {
    const button = parseReminderButtonId(event.buttonId);
    if (!button) return { route, outcome: "ignored", actionIds: [], reply: null };
    const reminderClaim = claimWebhookEvent({ provider: "whatsapp", externalId: event.messageId, eventType: "reminder", sender: maskPhone(event.from) }, db);
    if (!reminderClaim.claimed) return { route, outcome: "duplicate", actionIds: [], reply: null };
    const followup = getFollowup(button.followupId, db);
    if (!followup || (userId && followup.user_id !== userId)) {
      await send(deps, approver, "⚠️ Rappel introuvable.");
      return { route, outcome: "unknown", actionIds: [], reply: null };
    }
    try {
      if (button.decision === "done") {
        completeReminder(button.followupId, { db, settings, actor: "whatsapp" });
        await send(deps, approver, `✅ Rappel terminé : ${followup.title ?? followup.reason}`);
        completeWebhookEvent("whatsapp", event.messageId, "reminder_done", db);
        return { route, outcome: "reminder_done", actionIds: [], reply: null };
      }
      const updated = postponeFollowup(button.followupId, { in_days: 1 }, { db, settings, actor: "whatsapp" });
      await send(deps, approver, `⏭ Rappel reporté au ${formatDateTime(updated.execute_at, settings.company.timezone)}.`);
      completeWebhookEvent("whatsapp", event.messageId, "reminder_snoozed", db);
      return { route, outcome: "reminder_snoozed", actionIds: [], reply: null };
    } catch (err) {
      await send(deps, approver, `⚠️ ${err instanceof Error ? err.message : "Erreur"}`);
      failWebhookEvent("whatsapp", event.messageId, err instanceof Error ? err.message : "Erreur", db);
      return { route, outcome: "already_decided", actionIds: [], reply: null };
    }
  }
  if (route === "IGNORED") return { route, outcome: "ignored", actionIds: [], reply: null };

  const assistantEnabled = deps.assistantEnabled ?? getEnv().WHATSAPP_ASSISTANT_ENABLED;
  if (!assistantEnabled) {
    log.info("whatsapp assistant disabled: text message ignored");
    return { route: "IGNORED", outcome: "assistant_disabled", actionIds: [], reply: null };
  }

  // 2. Dédoublonnage Meta et cycle de traitement : un message traité une fois ne
  // rappelle jamais Claude ; un message interrompu est repris de façon contrôlée.
  const claim = claimWebhookEvent({ provider: "whatsapp", externalId: event.messageId, eventType: "text", sender: maskPhone(event.from) }, db);
  if (!claim.claimed) return { route, outcome: "duplicate", actionIds: [], reply: null };
  const finish = (r: RouterResult): RouterResult => {
    completeWebhookEvent("whatsapp", event.messageId, r.outcome, db);
    return r;
  };
  const text = (event.text ?? "").trim();

  // Reprise après interruption : si ce message a déjà été enregistré, il a pu
  // créer une action avant le crash. On ne rappelle jamais Claude dessus —
  // mieux vaut demander de renvoyer que de créer une seconde action.
  if (claim.resumed && chatRepo.getMessageByExternalId(event.messageId, db)) {
    const notice = "Une interruption a eu lieu pendant le traitement de cette demande. Merci de la renvoyer.";
    logHistory({ eventType: "whatsapp.interrupted", message: `Traitement interrompu pour un message déjà enregistré (tentative ${claim.event.attempts}) : reprise refusée`, actor: "system" }, db);
    await send(deps, approver, notice);
    return finish({ route, outcome: "interrupted", actionIds: [], reply: notice });
  }
  logHistory({ eventType: "whatsapp.message_received", message: `Message WhatsApp reçu (${masked}) : ${text.slice(0, 160)}`, actor: "user", userId }, db);

  // 3. Décision en langage naturel — uniquement si une action de CET utilisateur attend une validation.
  const pending = pendingActions(db, userId);
  const decision = parseNaturalDecision(text);
  if (decision && pending.length === 1) {
    chatRepo.insertMessage({ userId, role: "user", content: text, channel: "WHATSAPP", externalId: event.messageId, sender: masked, actionId: pending[0]!.id }, db);
    return finish(await decide(pending[0]!.id, decision, approver, deps, userId));
  }
  if (decision && pending.length > 1) {
    chatRepo.insertMessage({ userId, role: "user", content: text, channel: "WHATSAPP", externalId: event.messageId, sender: masked }, db);
    return finish(await askWhichAction(pending, decision, approver, deps, userId));
  }
  // Réponse à une désambiguïsation : « 1 », « le deuxième ».
  const ordinal = parseOrdinal(text);
  if (ordinal !== null) {
    const refs = lastRefs("WHATSAPP", db, userId);
    const target = refs.find((r) => r.index === ordinal && r.kind === "action" && r.pendingDecision !== null);
    if (target && pending.some((a) => a.id === target.id)) {
      chatRepo.insertMessage({ userId, role: "user", content: text, channel: "WHATSAPP", externalId: event.messageId, sender: masked, actionId: target.id }, db);
      return finish(await decide(target.id, target.pendingDecision as "approve" | "reject", approver, deps, userId));
    }
  }

  // 4. Assistant conversationnel (lecture / préparation). Aucun effet externe direct.
  //    Les tools reçoivent l'utilisateur identifié : seules SES données et SA boîte Outlook.
  try {
    log.info("whatsapp assistant turn", { userId, from: masked });
    const turn = await runWhatsappAssistantTurn(text, { db, settings, userId, userName: identity.name, client: deps.anthropic, model: deps.model, externalId: event.messageId, sender: masked });
    if (turn.reply) await send(deps, approver, turn.reply);
    for (const actionId of turn.newActionIds) {
      const approval = approvalsRepo.getPendingApprovalForAction(actionId, db);
      if (approval) await notifyPendingApproval(actionId, { db, settings, client: deps.client, approverPhone: approver });
    }
    log.info("whatsapp reply sent", { userId, from: masked, tools: turn.toolCalls.map((t) => `${t.name}:${t.ok ? "ok" : "ko"}`), actions: turn.newActionIds.length, reconnectRequired: turn.reconnectRequired === true });
    logHistory({ eventType: "whatsapp.assistant_replied", message: `Réponse envoyée${turn.newActionIds.length ? ` — ${turn.newActionIds.length} action(s) proposée(s)` : ""}`, actor: "ema", userId, details: { tools: turn.toolCalls.map((t) => t.name), actions: turn.newActionIds } }, db);
    return finish({ route, outcome: turn.reconnectRequired ? "reconnect_required" : turn.newActionIds.length ? "action_proposed" : "answered", actionIds: turn.newActionIds, reply: turn.reply });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("whatsapp assistant failed", { userId, message });
    logHistory({ eventType: "whatsapp.assistant_failed", message: `Assistant WhatsApp indisponible : ${message}`, actor: "system", userId }, db);
    await send(deps, approver, NO_LLM_REPLY);
    // L'assistant n'a rien produit : l'événement reste reprenable si Meta le rejoue.
    failWebhookEvent("whatsapp", event.messageId, message, db);
    return { route, outcome: "llm_error", actionIds: [], reply: NO_LLM_REPLY };
  }
}
