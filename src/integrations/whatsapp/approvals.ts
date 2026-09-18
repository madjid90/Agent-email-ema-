import type { Db } from "@/database/connection";
import { getDb } from "@/database/connection";
import * as actionsRepo from "@/database/repositories/actions";
import * as approvalsRepo from "@/database/repositories/approvals";
import * as emailsRepo from "@/database/repositories/emails";
import { getLatestAnalysis } from "@/database/repositories/analyses";
import { getDocument } from "@/database/repositories/documents";
import { formatAmount, formatDateTime } from "@/lib/time";
import { getFollowup } from "@/database/repositories/followups";
import { logHistory } from "@/database/repositories/history";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from "@/database/repositories/webhook-events";
import type { ActionRow, ApprovalRow } from "@/database/types";
import { parseJson } from "@/database/types";
import { getApproverPhone } from "@/lib/env";
import { whatsappRecipientFor } from "@/database/repositories/users";
import { getCompanies, getSettings, type Settings } from "@/lib/config";
import { EmaError } from "@/lib/errors";
import { nowIso } from "@/lib/ids";
import { createLogger } from "@/lib/logger";
import { approveAndExecute, rejectAction } from "@/actions/engine";
import { getWhatsappClient, isWhatsappConfigured, type WhatsappClient } from "./client";
import { buildApprovalMessages, textMessage, type ApprovalMessageInput } from "./messages";
import { parseButtonId } from "./webhook";
import type { WhatsappInboundEvent } from "./types";

const log = createLogger("whatsapp.approvals");

export const MAX_NOTIFY_ATTEMPTS = 5;

export interface ApprovalDeps {
  db?: Db;
  client?: WhatsappClient;
  settings?: Settings;
  /** Numéro explicite (tests, instance historique). Sinon : numéro vérifié du propriétaire de l'action. */
  approverPhone?: string | null;
  /** Utilisateur identifié par le webhook : ne peut décider que de SES actions. */
  userId?: string | null;
  now?: () => string;
}

function resolve(deps: ApprovalDeps): { db: Db; settings: Settings; approver: string | null } {
  return { db: deps.db ?? getDb(), settings: deps.settings ?? getSettings(), approver: deps.approverPhone === undefined ? getApproverPhone() : deps.approverPhone };
}

/**
 * Destinataire d'une notification : le numéro WhatsApp vérifié du propriétaire
 * de l'action. Une action sans propriétaire (données historiques) retombe sur
 * le numéro explicite ou WHATSAPP_APPROVER_PHONE.
 */
function approverFor(action: ActionRow, deps: ApprovalDeps, db: Db): string | null {
  if (deps.approverPhone !== undefined) return deps.approverPhone;
  if (action.user_id) return whatsappRecipientFor(action.user_id, db);
  return getApproverPhone();
}

const ACTION_LABEL: Record<string, string> = {
  reply_email: "Répondre à l'email dans le thread",
  forward_email: "Transférer l'email",
  send_email: "Envoyer un nouvel email",
  payment_request: "Envoyer une demande de règlement interne",
  deposit_request: "Envoyer une demande d'acompte interne",
  sign_document: "Signer et tamponner le document, puis le renvoyer",
  send_followup: "Envoyer une relance",
};

export function buildApprovalMessageInput(action: ActionRow, approval: ApprovalRow, db: Db): ApprovalMessageInput {
  const email = action.source_email_id ? emailsRepo.getEmail(action.source_email_id, db) : undefined;
  const analysis = email ? getLatestAnalysis(email.id, db) : undefined;
  const payload = parseJson<Record<string, unknown>>(action.payload, {});
  const companies = new Map(getCompanies().map((c) => [c.id, c.name]));
  const companyId = action.company_id ?? analysis?.company_id ?? null;
  const to = Array.isArray(payload.to) ? (payload.to as string[]).join(", ") : null;
  const notes: string[] = [];
  if (analysis?.requires_human_review === 1) notes.push("Validation humaine requise");
  if (analysis?.injection_suspected === 1) notes.push("tentative d'instruction détectée dans l'email");
  const doc = action.document_id ? getDocument(action.document_id, db) : undefined;
  const details: { label: string; value: string }[] = [];
  const supplier = doc?.supplier_name ?? (typeof payload.supplier === "string" ? payload.supplier : null);
  if (supplier) details.push({ label: "Fournisseur", value: supplier });
  if (doc?.invoice_number) details.push({ label: "Facture", value: doc.invoice_number });
  const amount = doc?.amount_incl_tax ?? (typeof payload.amount === "number" ? payload.amount : analysis?.amount_value ?? null);
  if (amount !== null) details.push({ label: "Montant", value: `${formatAmount(amount, doc?.currency ?? (typeof payload.currency === "string" ? payload.currency : "EUR"))}${doc?.amount_incl_tax !== null && doc?.amount_incl_tax !== undefined ? " TTC" : ""}` });
  const due = doc?.due_date ?? (typeof payload.due_date === "string" ? payload.due_date : analysis?.due_date ?? null);
  if (due) details.push({ label: "Échéance", value: due });
  if (doc?.possible_duplicate === 1) notes.push("doublon potentiel de facture");
  if (doc?.bank_details_change === 1) notes.push("changement de coordonnées bancaires détecté");
  // Relance (phase 7) : même carte de validation, titre et détails dédiés.
  const followupId = typeof payload.followup_id === "string" ? payload.followup_id : null;
  if (followupId) {
    const followup = getFollowup(followupId, db);
    const tz = getSettings().company.timezone;
    const followupDetails: { label: string; value: string }[] = [
      { label: "Contact", value: followup?.recipient ?? email?.sender_name ?? email?.sender_email ?? "—" },
      { label: "Sujet", value: email?.subject ?? action.title },
      { label: "Dernier message envoyé", value: followup?.watch_after ? formatDateTime(followup.watch_after, tz) : "—" },
      { label: "Réponse reçue", value: followup?.last_reply_email_id ? "Réponse automatique détectée" : "Aucune" },
      { label: "Tentative", value: followup ? `${(typeof payload.attempt === "number" ? payload.attempt : followup.attempts + 1).toString()} / ${followup.max_attempts}` : "—" },
    ];
    return {
      approvalId: approval.id,
      kind: "followup_reply",
      senderName: email?.sender_name ?? null,
      senderEmail: email?.sender_email ?? null,
      company: companyId ? companies.get(companyId) ?? companyId : null,
      subject: email?.subject ?? action.title,
      summary: followup?.reason ?? null,
      proposedAction: "Envoyer la relance dans le thread Outlook",
      proposedReply: approval.proposed_reply,
      confidence: null,
      humanReviewNote: notes.length ? notes.join(" — ") : null,
      details: followupDetails,
      note: null,
    };
  }
  const isPayment = action.type === "payment_request" || action.type === "deposit_request";
  if (action.type === "sign_document") {
    const p = payload as Record<string, unknown>;
    const steps = ["✓ " + (typeof p.approval_text === "string" ? p.approval_text : "Bon pour accord"), "✓ Date du jour", `✓ ${typeof p.signature_label === "string" ? p.signature_label : "Signature autorisée"}`, p.stamp_required ? `✓ ${typeof p.stamp_label === "string" ? p.stamp_label : "Tampon société"}` : "✗ Sans tampon", `✓ Retour au fournisseur${typeof p.reply_to === "string" ? ` (${p.reply_to})` : ""}`];
    const signDetails: { label: string; value: string }[] = [];
    if (typeof p.supplier_name === "string") signDetails.push({ label: "Fournisseur", value: p.supplier_name });
    if (typeof p.quote_number === "string") signDetails.push({ label: "Devis", value: p.quote_number });
    if (typeof p.subject === "string") signDetails.push({ label: "Objet", value: p.subject });
    signDetails.push({ label: "Montant", value: typeof p.amount_incl_tax === "number" ? `${formatAmount(p.amount_incl_tax, typeof p.currency === "string" ? p.currency : "EUR")} TTC` : "Non détecté ⚠️ Vérification recommandée" });
    const signNotes = [...(Array.isArray(p.warnings) ? (p.warnings as string[]) : [])];
    if (analysis?.injection_suspected === 1) signNotes.push("tentative d'instruction détectée dans l'email");
    return {
      approvalId: approval.id,
      kind: action.type,
      senderName: email?.sender_name ?? null,
      senderEmail: email?.sender_email ?? null,
      company: companyId ? companies.get(companyId) ?? companyId : null,
      subject: email?.subject ?? action.title,
      summary: null,
      proposedAction: `\n${steps.join("\n")}`,
      proposedReply: null,
      confidence: doc?.doc_confidence ?? null,
      humanReviewNote: signNotes.length ? signNotes.join(" — ") : null,
      details: signDetails,
      note: "⚠️ Cette action appliquera réellement votre signature enregistrée sur une copie du devis (l'original reste inchangé).",
    };
  }
  return {
    approvalId: approval.id,
    kind: action.type,
    senderName: email?.sender_name ?? null,
    senderEmail: email?.sender_email ?? null,
    company: companyId ? companies.get(companyId) ?? companyId : analysis?.company_name ?? null,
    subject: email?.subject ?? (typeof payload.subject === "string" ? payload.subject : action.title),
    summary: analysis?.summary ?? null,
    proposedAction: `${ACTION_LABEL[action.type] ?? action.type}${to ? ` → ${to}` : ""}`,
    proposedReply: approval.proposed_reply,
    confidence: doc?.doc_confidence ?? analysis?.confidence ?? null,
    humanReviewNote: notes.length ? notes.join(" — ") : null,
    details,
    note: isPayment ? "⚠️ EMA n'effectuera aucun paiement bancaire : seul un email interne de demande de règlement sera envoyé." : null,
  };
}

/**
 * Envoie la demande de validation WhatsApp pour une action en attente.
 * Une seule notification active : si la demande PENDING a déjà été envoyée,
 * rien n'est renvoyé. Ne lève pas : l'échec est enregistré (retenté par le worker).
 */
export async function notifyPendingApproval(actionId: string, deps: ApprovalDeps = {}): Promise<{ sent: boolean; reason: string; approvalId: string | null }> {
  const { db, settings } = resolve(deps);
  const action = actionsRepo.getAction(actionId, db);
  if (!action) throw new EmaError("NOT_FOUND", `Action ${actionId} introuvable`);
  const approver = approverFor(action, deps, db);
  const approval = approvalsRepo.getPendingApprovalForAction(actionId, db);
  if (!approval) return { sent: false, reason: "aucune validation en attente", approvalId: null };
  if (approval.external_message_id) return { sent: false, reason: "notification déjà envoyée", approvalId: approval.id };
  if (settings.approvals.channel !== "whatsapp") return { sent: false, reason: "canal de validation : interface", approvalId: approval.id };
  if (!deps.client && !isWhatsappConfigured()) return { sent: false, reason: "WhatsApp non configuré", approvalId: approval.id };
  if (!approver) return { sent: false, reason: action.user_id ? "numéro WhatsApp de l'utilisateur non vérifié" : "WHATSAPP_APPROVER_PHONE non renseigné", approvalId: approval.id };
  if (approval.notify_attempts >= MAX_NOTIFY_ATTEMPTS) return { sent: false, reason: "nombre maximal de tentatives atteint", approvalId: approval.id };

  const client = deps.client ?? getWhatsappClient();
  const messages = buildApprovalMessages(approver, buildApprovalMessageInput(action, approval, db));
  try {
    let lastId = "";
    for (const m of messages) lastId = (await client.send(m)).messageId;
    approvalsRepo.markApprovalSent(approval.id, lastId, db);
    logHistory({ eventType: "approval.sent", message: "Demande de validation envoyée sur WhatsApp", actor: "ema", actionId, emailId: action.source_email_id, approvalId: approval.id }, db);
    return { sent: true, reason: "envoyée", approvalId: approval.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    approvalsRepo.markApprovalNotifyFailed(approval.id, message, db);
    logHistory({ eventType: "approval.send_failed", message: `Envoi WhatsApp échoué : ${message}`, actor: "system", actionId, emailId: action.source_email_id, approvalId: approval.id }, db);
    log.warn("approval notification failed", { actionId, message });
    return { sent: false, reason: message, approvalId: approval.id };
  }
}

/** Relance des notifications jamais parties (worker). */
export async function notifyUnsentApprovals(deps: ApprovalDeps = {}): Promise<number> {
  const { db } = resolve(deps);
  let sent = 0;
  for (const apr of approvalsRepo.listPendingUnsentApprovals(MAX_NOTIFY_ATTEMPTS, db)) {
    const r = await notifyPendingApproval(apr.action_id, deps);
    if (r.sent) sent++;
  }
  return sent;
}

export interface DecisionResult {
  handled: boolean;
  outcome: "approved" | "rejected" | "ignored" | "expired" | "already_decided" | "unauthorized" | "unknown" | "duplicate" | "failed";
  actionId: string | null;
  message: string;
}

/**
 * Traite un événement WhatsApp entrant : numéro autorisé, dédoublonnage,
 * approval PENDING et non expirée, puis décision via l'Action Engine.
 * La transition atomique de l'engine empêche toute double exécution.
 */
export async function handleInboundEvent(event: WhatsappInboundEvent, deps: ApprovalDeps = {}): Promise<DecisionResult> {
  const { db, approver } = resolve(deps);
  const now = deps.now ?? nowIso;
  if (!approver || event.from !== approver) {
    log.warn("whatsapp event from unauthorized number", { from: maskPhone(event.from) });
    return { handled: false, outcome: "unauthorized", actionId: null, message: "Numéro non autorisé" };
  }
  // Claim atomique : reprise possible si un crash a laissé l'événement en cours.
  // Les décisions sont idempotentes (Action Engine), une reprise est donc sûre.
  const claim = claimWebhookEvent({ provider: "whatsapp", externalId: event.messageId, eventType: event.kind, sender: maskPhone(event.from) }, db);
  if (!claim.claimed) {
    return { handled: false, outcome: "duplicate", actionId: null, message: claim.reason === "already_processed" ? "Événement déjà traité" : "Événement en cours de traitement" };
  }
  if (claim.resumed) log.warn("resuming interrupted approval event", { attempts: claim.event.attempts });
  const finish = (r: DecisionResult): DecisionResult => {
    completeWebhookEvent("whatsapp", event.messageId, r.outcome, db);
    return r;
  };
  const button = parseButtonId(event.buttonId);
  if (!button) return finish({ handled: false, outcome: "ignored", actionId: null, message: "Message sans bouton de validation" });

  const approval = approvalsRepo.getApproval(button.approvalId, db);
  if (!approval) {
    await reply(deps, approver, "⚠ Demande de validation introuvable.");
    return finish({ handled: false, outcome: "unknown", actionId: null, message: "Approval inexistante" });
  }
  const action = actionsRepo.getAction(approval.action_id, db);
  // Isolation : un utilisateur identifié ne décide que de SES actions. Une demande
  // d'un autre compte est traitée comme inexistante, sans révéler son contenu.
  if (deps.userId && action && action.user_id !== deps.userId) {
    log.warn("whatsapp decision on another user's action ignored", { userId: deps.userId });
    await reply(deps, approver, "⚠ Demande de validation introuvable.");
    return finish({ handled: false, outcome: "unauthorized", actionId: null, message: "Action d'un autre utilisateur" });
  }
  if (approval.status !== "PENDING") {
    await reply(deps, approver, `ℹ Cette demande a déjà été traitée (${approval.status}).`);
    return finish({ handled: false, outcome: "already_decided", actionId: approval.action_id, message: `Approval déjà ${approval.status}` });
  }
  if (approval.expires_at <= now()) {
    approvalsRepo.decideApproval(approval.id, "EXPIRED", "system", "Délai dépassé", db);
    logHistory({ eventType: "approval.expired", message: "Validation reçue après expiration : ignorée", actor: "whatsapp", actionId: approval.action_id, approvalId: approval.id }, db);
    await reply(deps, approver, "⏰ Cette demande a expiré. Renvoyez-la depuis l'interface EMA.");
    return finish({ handled: false, outcome: "expired", actionId: approval.action_id, message: "Approval expirée" });
  }
  const decidedBy = `whatsapp:${maskPhone(approver)}`;
  if (button.decision === "reject") {
    try {
      rejectAction(approval.action_id, decidedBy, "Refusé sur WhatsApp", { db, settings: deps.settings });
    } catch (err) {
      return finish({ handled: false, outcome: "already_decided", actionId: approval.action_id, message: err instanceof Error ? err.message : "Refus impossible" });
    }
    await reply(deps, approver, `❌ Action refusée : ${action?.title ?? approval.summary}. Aucun email envoyé.`);
    return finish({ handled: true, outcome: "rejected", actionId: approval.action_id, message: "Action refusée" });
  }
  try {
    const result = await approveAndExecute(approval.action_id, decidedBy, { db, settings: deps.settings });
    if (result.status === "COMPLETED") {
      await reply(deps, approver, `✅ Fait : ${result.title}.`);
      return finish({ handled: true, outcome: "approved", actionId: result.id, message: "Action exécutée" });
    }
    await reply(deps, approver, `⚠ Validée mais l'envoi a échoué : ${result.error ?? "erreur inconnue"}. Réessayez depuis l'interface EMA.`);
    return finish({ handled: true, outcome: "failed", actionId: result.id, message: result.error ?? "Échec d'exécution" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur";
    // CONFLICT = déjà exécutée (double clic, validation UI simultanée) : rien à refaire.
    const alreadyDone = err instanceof EmaError && err.code === "CONFLICT";
    await reply(deps, approver, alreadyDone ? "ℹ Cette action a déjà été traitée." : `⚠ ${message}`);
    if (alreadyDone) return finish({ handled: false, outcome: "already_decided", actionId: approval.action_id, message });
    failWebhookEvent("whatsapp", event.messageId, message, db);
    return { handled: false, outcome: "failed", actionId: approval.action_id, message };
  }
}

async function reply(deps: ApprovalDeps, to: string, body: string): Promise<void> {
  try {
    const client = deps.client ?? (isWhatsappConfigured() ? getWhatsappClient() : null);
    if (client) await client.send(textMessage(to, body));
  } catch (err) {
    log.warn("whatsapp confirmation failed", { message: err instanceof Error ? err.message : String(err) });
  }
}

export function maskPhone(phone: string | null): string {
  if (!phone) return "—";
  return phone.length > 6 ? `${phone.slice(0, 4)}…${phone.slice(-2)}` : "…";
}
