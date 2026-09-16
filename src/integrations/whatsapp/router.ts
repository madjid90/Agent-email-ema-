import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as actionsRepo from "@/database/repositories/actions";
import * as approvalsRepo from "@/database/repositories/approvals";
import * as chatRepo from "@/database/repositories/chat";
import { logHistory } from "@/database/repositories/history";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from "@/database/repositories/webhook-events";
import type { ActionRow } from "@/database/types";
import { getApproverPhone, getEnv } from "@/lib/env";
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
  approverPhone?: string | null;
  assistantEnabled?: boolean;
}

export interface RouterResult {
  route: WhatsappRoute;
  outcome: string;
  actionIds: string[];
  reply: string | null;
}

export const NO_LLM_REPLY = "Je n'ai pas pu traiter ta demande. Aucun email ni document n'a été modifié.";

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

function pendingActions(db: Db): ActionRow[] {
  return actionsRepo.listActions({ status: ["WAITING_APPROVAL"], limit: 20 }, db);
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
async function decide(actionId: string, decision: "approve" | "reject", approver: string, deps: RouterDeps): Promise<RouterResult> {
  const db = deps.db ?? getDb();
  const decidedBy = `whatsapp:${maskPhone(approver)}`;
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
async function askWhichAction(actions: ActionRow[], decision: "approve" | "reject", approver: string, deps: RouterDeps): Promise<RouterResult> {
  const db = deps.db ?? getDb();
  const refs = numberRefs(actions.map((a) => ({ kind: "action" as const, id: a.id, label: a.title, pendingDecision: decision })));
  const body = [`${decision === "approve" ? "Quelle action souhaites-tu valider" : "Quelle action souhaites-tu refuser"} ?`, "", ...refs.map((r) => `${r.index}. ${r.label}`), "", "Réponds par le numéro (ex. « 1 »)."].join("\n");
  chatRepo.insertMessage({ role: "assistant", content: body, channel: "WHATSAPP", refs }, db);
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
  const approver = deps.approverPhone === undefined ? getApproverPhone() : deps.approverPhone;
  const route = classifyEvent(event);

  // 1. Numéro autorisé — avant toute lecture de données, tout appel à Claude, toute action.
  if (!approver || event.from !== approver) {
    log.warn("whatsapp message from unauthorized number ignored", { from: maskPhone(event.from), route });
    return { route: "IGNORED", outcome: "unauthorized", actionIds: [], reply: null };
  }
  if (route === "APPROVAL_INTERACTION") {
    const r = await handleInboundEvent(event, { db, settings, client: deps.client, approverPhone: approver });
    return { route, outcome: r.outcome, actionIds: r.actionId ? [r.actionId] : [], reply: null };
  }
  // Boutons d'un rappel interne : terminé / reporter. Aucun email n'est impliqué.
  if (route === "REMINDER_INTERACTION") {
    const button = parseReminderButtonId(event.buttonId);
    if (!button) return { route, outcome: "ignored", actionIds: [], reply: null };
    const reminderClaim = claimWebhookEvent({ provider: "whatsapp", externalId: event.messageId, eventType: "reminder", sender: maskPhone(event.from) }, db);
    if (!reminderClaim.claimed) return { route, outcome: "duplicate", actionIds: [], reply: null };
    const followup = getFollowup(button.followupId, db);
    if (!followup) {
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
  logHistory({ eventType: "whatsapp.message_received", message: `Message WhatsApp reçu (${maskPhone(event.from)}) : ${text.slice(0, 160)}`, actor: "user" }, db);

  // 3. Décision en langage naturel — uniquement si une action attend réellement une validation.
  const pending = pendingActions(db);
  const decision = parseNaturalDecision(text);
  if (decision && pending.length === 1) {
    chatRepo.insertMessage({ role: "user", content: text, channel: "WHATSAPP", externalId: event.messageId, sender: maskPhone(event.from), actionId: pending[0]!.id }, db);
    return finish(await decide(pending[0]!.id, decision, approver, deps));
  }
  if (decision && pending.length > 1) {
    chatRepo.insertMessage({ role: "user", content: text, channel: "WHATSAPP", externalId: event.messageId, sender: maskPhone(event.from) }, db);
    return finish(await askWhichAction(pending, decision, approver, deps));
  }
  // Réponse à une désambiguïsation : « 1 », « le deuxième ».
  const ordinal = parseOrdinal(text);
  if (ordinal !== null) {
    const refs = lastRefs("WHATSAPP", db);
    const target = refs.find((r) => r.index === ordinal && r.kind === "action" && r.pendingDecision !== null);
    if (target && pending.some((a) => a.id === target.id)) {
      chatRepo.insertMessage({ role: "user", content: text, channel: "WHATSAPP", externalId: event.messageId, sender: maskPhone(event.from), actionId: target.id }, db);
      return finish(await decide(target.id, target.pendingDecision as "approve" | "reject", approver, deps));
    }
  }

  // 4. Assistant conversationnel (lecture / préparation). Aucun effet externe direct.
  try {
    const turn = await runWhatsappAssistantTurn(text, { db, settings, client: deps.anthropic, model: deps.model, externalId: event.messageId, sender: maskPhone(event.from) });
    if (turn.reply) await send(deps, approver, turn.reply);
    for (const actionId of turn.newActionIds) {
      const approval = approvalsRepo.getPendingApprovalForAction(actionId, db);
      if (approval) await notifyPendingApproval(actionId, { db, settings, client: deps.client, approverPhone: approver });
    }
    logHistory({ eventType: "whatsapp.assistant_replied", message: `Réponse envoyée${turn.newActionIds.length ? ` — ${turn.newActionIds.length} action(s) proposée(s)` : ""}`, actor: "ema", details: { tools: turn.toolCalls.map((t) => t.name), actions: turn.newActionIds } }, db);
    return finish({ route, outcome: turn.newActionIds.length ? "action_proposed" : "answered", actionIds: turn.newActionIds, reply: turn.reply });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("whatsapp assistant failed", { message });
    logHistory({ eventType: "whatsapp.assistant_failed", message: `Assistant WhatsApp indisponible : ${message}`, actor: "system" }, db);
    await send(deps, approver, NO_LLM_REPLY);
    // L'assistant n'a rien produit : l'événement reste reprenable si Meta le rejoue.
    failWebhookEvent("whatsapp", event.messageId, message, db);
    return { route, outcome: "llm_error", actionIds: [], reply: NO_LLM_REPLY };
  }
}
